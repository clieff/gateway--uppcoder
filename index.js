import "dotenv/config";
import http from "node:http";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import axios from "axios";
import pino from "pino";
import { saveMessage, saveMessages, updateContact } from "./db.js";
import {
  clearSupabaseAuthState,
  useSupabaseAuthState,
} from "./auth-state.js";
import {
  getCatalogProducts,
  normalizeJid,
  sendCatalogLink,
  sendProductCard,
  sendProductList,
} from "./catalog.js";

function normalizeWebhookUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  const configuredUrl = value.trim();
  const candidate = /^https?:\/\//i.test(configuredUrl)
    ? configuredUrl
    : `https://${configuredUrl}`;

  let parsedUrl;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    throw new Error("VERCEL_WEBHOOK_URL n’est pas une URL valide.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
    throw new Error("VERCEL_WEBHOOK_URL doit être une URL HTTP ou HTTPS valide.");
  }

  return parsedUrl.toString();
}

const WEBHOOK_URL = normalizeWebhookUrl(process.env.VERCEL_WEBHOOK_URL);
const GATEWAY_API_SECRET = process.env.GATEWAY_API_SECRET;
const VERCEL_AUTOMATION_BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const BUSINESS_JID = normalizeJid(process.env.BUSINESS_JID);
const PORT = Number(
  process.env.PORT ||
    process.env.APP_PORT ||
    process.env.GATEWAY_PORT ||
    3000,
);
const CATALOG_RESPONSE_TIMEOUT_MS = 3_000;
const CATALOG_BACKGROUND_TIMEOUT_MS = 60_000;
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const catalogCache = {
  products: [],
  refreshedAt: 0,
  refreshPromise: null,
  refreshTimedOut: false,
  retryAfter: 0,
  refreshFailed: false,
};
const chatQueues = new Map();
let socket;
let reconnectTimer;

function safeErrorDetails(error) {
  return {
    message: error?.message || String(error),
    code: error?.code,
    status: error?.response?.status,
  };
}

if (!WEBHOOK_URL || !GATEWAY_API_SECRET || !BUSINESS_JID) {
  throw new Error(
    "Définissez VERCEL_WEBHOOK_URL, GATEWAY_API_SECRET et BUSINESS_JID dans gateway-uppcoder/.env.",
  );
}

function timestampDate(value) {
  if (value instanceof Date) return value;
  const seconds =
    typeof value?.toNumber === "function"
      ? value.toNumber()
      : Number(value || 0);
  return new Date((seconds || Date.now() / 1000) * 1000);
}

function messageContent(message) {
  return normalizeMessageContent(message?.message) || message?.message || {};
}

function messageBody(message) {
  const content = messageContent(message);
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.productMessage?.product?.title ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    ""
  );
}

function getSelectedProductId(message) {
  const content = messageContent(message);
  const rowId = content.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (rowId?.startsWith("product:")) return rowId.slice("product:".length);

  const paramsJson =
    content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (paramsJson) {
    try {
      const params = JSON.parse(paramsJson);
      const id = params.id || params.row_id || params.selectedRowId;
      if (String(id || "").startsWith("product:"))
        return String(id).slice("product:".length);
      if (id) return String(id);
    } catch {
      logger.debug("Réponse interactive reçue avec un JSON non décodable.");
    }
  }
  return null;
}

function isDirectChat(jid) {
  return (
    typeof jid === "string" &&
    (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"))
  );
}

async function refreshCatalog({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - catalogCache.refreshedAt < 60_000)
    return catalogCache.products;
  if (catalogCache.refreshPromise && catalogCache.refreshTimedOut) return [];

  if (!catalogCache.refreshPromise) {
    if (now < catalogCache.retryAfter) return catalogCache.products;

    const catalogRead = Promise.resolve()
      .then(() => getCatalogProducts())
      .then((products) => {
        catalogCache.products = products;
        catalogCache.refreshedAt = Date.now();
        catalogCache.retryAfter = 0;
        catalogCache.refreshFailed = false;
        return products;
      });
    let backgroundTimeout;
    const pending = Promise.race([
      catalogRead,
      new Promise((_, reject) => {
        backgroundTimeout = setTimeout(
          () =>
            reject(
              new Error("Délai maximal de lecture du catalogue dépassé en arrière-plan."),
            ),
          CATALOG_BACKGROUND_TIMEOUT_MS,
        );
      }),
    ])
      .catch((error) => {
        catalogCache.retryAfter = Date.now() + 60_000;
        catalogCache.refreshFailed = true;
        logger.warn(
          { err: safeErrorDetails(error), cachedProducts: catalogCache.products.length },
          "Catalogue WhatsApp indisponible; le dernier cache est conservé.",
        );
        return catalogCache.products;
      })
      .finally(() => {
        clearTimeout(backgroundTimeout);
        if (catalogCache.refreshPromise === pending) {
          catalogCache.refreshPromise = null;
          catalogCache.refreshTimedOut = false;
        }
      });
    catalogCache.refreshPromise = pending;
  }

  const pending = catalogCache.refreshPromise;
  const timedOut = Symbol("catalog-refresh-timeout");
  let timeout;
  const result = await Promise.race([
    pending,
    new Promise((resolve) => {
      timeout = setTimeout(
        () => resolve(timedOut),
        CATALOG_RESPONSE_TIMEOUT_MS,
      );
    }),
  ]);
  clearTimeout(timeout);

  if (result === timedOut) {
    catalogCache.refreshTimedOut = true;
    catalogCache.refreshFailed = true;
    logger.warn(
      { cachedProducts: catalogCache.products.length },
      "Catalogue > 3 s; Vercel reçoit le message sans catalogue, l’actualisation continue en arrière-plan.",
    );
    return [];
  }

  return result;
}

async function saveInbound(message, jid) {
  const fromMe = Boolean(message.key?.fromMe);
  const timestamp = timestampDate(message.messageTimestamp);
  let wasInserted = true;
  let savedSuccessfully = false;

  try {
    const result = await saveMessage({
      jid,
      messageId: message.key?.id,
      fromMe,
      body: messageBody(message),
      messageType: Object.keys(messageContent(message))[0] || "unknown",
      timestamp,
    });
    savedSuccessfully = true;
    wasInserted = Boolean(result?.inserted);
  } catch (error) {
    // Une panne Supabase ne doit pas empêcher le traitement ni la réponse WhatsApp.
    logger.error(
      { err: error, jid, messageId: message.key?.id },
      "Message reçu non enregistré dans Supabase; le traitement continue.",
    );
  }

  if (savedSuccessfully && wasInserted && !fromMe) {
    try {
      await updateContact({
        jid,
        pushName: message.pushName || null,
        lastInteraction: timestamp,
      });
    } catch (error) {
      logger.error(
        { err: error, jid },
        "Contact non actualisé dans Supabase; le traitement continue.",
      );
    }
  }
  return wasInserted;
}

async function saveHistory(messages) {
  const records = [];
  const latestByContact = new Map();
  for (const message of messages || []) {
    const jid = normalizeJid(
      message.key?.remoteJid || message.key?.remoteJidAlt,
    );
    if (!message.key?.id || !isDirectChat(jid)) continue;
    const timestamp = timestampDate(message.messageTimestamp);
    records.push({
      jid,
      messageId: message.key.id,
      fromMe: Boolean(message.key.fromMe),
      body: messageBody(message),
      messageType: Object.keys(messageContent(message))[0] || "unknown",
      timestamp,
    });
    if (!message.key.fromMe) {
      const previous = latestByContact.get(jid);
      if (!previous || timestamp > previous.lastInteraction) {
        latestByContact.set(jid, {
          jid,
          pushName: message.pushName || null,
          lastInteraction: timestamp,
        });
      }
    }
  }

  for (let offset = 0; offset < records.length; offset += 100) {
    try {
      await saveMessages(records.slice(offset, offset + 100));
    } catch (error) {
      logger.error(
        { err: error, offset, batchSize: Math.min(100, records.length - offset) },
        "Lot d’historique non enregistré dans Supabase; la synchronisation continue.",
      );
    }
  }
  await Promise.all(
    [...latestByContact.values()].map(async (contact) => {
      try {
        await updateContact(contact);
      } catch (error) {
        logger.error(
          { err: error, jid: contact.jid },
          "Contact historique non actualisé dans Supabase.",
        );
      }
    }),
  );
  logger.info(
    { stored: records.length, contacts: latestByContact.size },
    "Synchronisation de l’historique terminée.",
  );
}

function queueForChat(jid, job) {
  const previous = chatQueues.get(jid) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(job)
    .catch((error) => {
      logger.error({ err: error, jid }, "Échec du traitement du message.");
    })
    .finally(() => {
      if (chatQueues.get(jid) === current) chatQueues.delete(jid);
    });
  chatQueues.set(jid, current);
  return current;
}

async function saveOutbound(jid, result, text, messageType) {
  const id = result?.key?.id;
  if (!id) return;
  try {
    await saveMessage({
      jid,
      messageId: id,
      fromMe: true,
      body: text || "",
      messageType,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(
      { err: error, jid },
      "Réponse envoyée mais impossible à sauvegarder dans Supabase.",
    );
  }
}

async function sendCatalogUnavailableNotice(jid) {
  const text =
    "Je consulte nos stocks, un instant. Le catalogue est temporairement indisponible.";
  try {
    const sent = await socket.sendMessage(jid, { text });
    await saveOutbound(jid, sent, text, "conversation");
    return true;
  } catch (error) {
    logger.error(
      { err: error, jid },
      "Impossible d’envoyer le message de secours du catalogue.",
    );
    return false;
  }
}

async function sendAction(jid, action, products) {
  const message = String(action?.message || "").slice(0, 3000);
  if (action?.type === "product_card") {
    const product = products.find(
      (item) => item.id === String(action.product_id || ""),
    );
    if (!product) {
      const text =
        "Je ne retrouve pas ce produit dans le catalogue actuel. Souhaitez-vous que je vous envoie le catalogue complet ?";
      const sent = await socket.sendMessage(jid, { text });
      await saveOutbound(jid, sent, text, "conversation");
      return;
    }
    const result = await sendProductCard(
      socket,
      jid,
      product,
      BUSINESS_JID,
      message,
    );
    await saveOutbound(
      jid,
      result,
      `Fiche produit : ${product.title}`,
      product.imageUrl ? "productMessage" : "conversation",
    );
    return;
  }

  if (action?.type === "product_list") {
    const selectedIds = Array.isArray(action.products)
      ? action.products.map(String)
      : [];
    const chosen = selectedIds
      .map((id) => products.find((item) => item.id === id))
      .filter(Boolean);
    if (!chosen.length) {
      const text =
        "Je n’ai pas trouvé de produit correspondant dans le catalogue actuel. Vous pouvez consulter le catalogue complet.";
      const sent = await socket.sendMessage(jid, { text });
      await saveOutbound(jid, sent, text, "conversation");
      return;
    }
    const result = await sendProductList(
      socket,
      jid,
      chosen,
      message || "Voici les produits correspondants.",
    );
    await saveOutbound(
      jid,
      result,
      message || "Liste de produits",
      chosen.length ? "listMessage" : "conversation",
    );
    return;
  }

  if (action?.type === "catalog_link") {
    const result = await sendCatalogLink(
      socket,
      jid,
      BUSINESS_JID,
      null,
      message || "Voici notre catalogue complet.",
    );
    await saveOutbound(
      jid,
      result,
      `${message || "Voici notre catalogue complet."} https://wa.me/c/${BUSINESS_JID.split("@")[0]}`,
      "conversation",
    );
    return;
  }

  const text =
    message || "Merci pour votre message. Comment puis-je vous aider ?";
  const sent = await socket.sendMessage(jid, { text });
  await saveOutbound(jid, sent, text, "conversation");
}

async function processLiveMessage(message, jid) {
  let inserted = true;
  try {
    inserted = await saveInbound(message, jid);
  } catch (error) {
    // Même une erreur inattendue pendant la sauvegarde ne doit pas bloquer Vercel.
    logger.error(
      { err: error, jid, messageId: message.key?.id },
      "Échec de sauvegarde du message entrant; le traitement continue vers Vercel.",
    );
  }
  if (!inserted || message.key?.fromMe) return;

  const selectedProductId = getSelectedProductId(message);
  if (selectedProductId) {
    const products = await refreshCatalog();
    const product = products.find((item) => item.id === selectedProductId);
    if (product) {
      const result = await sendProductCard(
        socket,
        jid,
        product,
        BUSINESS_JID,
        "Voici la fiche du produit sélectionné.",
      );
      await saveOutbound(
        jid,
        result,
        `Fiche produit : ${product.title}`,
        "productMessage",
      );
      return;
    }
    if (catalogCache.refreshFailed && !catalogCache.refreshTimedOut) {
      await sendCatalogUnavailableNotice(jid);
      return;
    }
  }

  const body = messageBody(message).trim().slice(0, 16000);
  if (!body) {
    const text =
      "Je n’ai pas pu lire ce message. Pouvez-vous m’écrire votre demande en texte ?";
    const sent = await socket.sendMessage(jid, { text });
    await saveOutbound(jid, sent, text, "conversation");
    return;
  }

  const products = await refreshCatalog();
  const publicProducts = products.map(
    ({ id, title, description, price, currency, retailerId }) => ({
      id,
      title,
      description,
      price,
      currency,
      retailerId,
    }),
  );

  try {
    const response = await axios.post(
      WEBHOOK_URL,
      {
        jid,
        messageId: message.key.id,
        message: body,
        pushName: message.pushName || null,
        catalogProducts: publicProducts,
      },
      {
        timeout: 55_000,
        headers: {
          Authorization: `Bearer ${GATEWAY_API_SECRET}`,
          ...(VERCEL_AUTOMATION_BYPASS_SECRET
            ? { "x-vercel-protection-bypass": VERCEL_AUTOMATION_BYPASS_SECRET }
            : {}),
        },
      },
    );
    await sendAction(jid, response.data, products);
  } catch (error) {
    logger.error(
      {
        err: safeErrorDetails(error),
        responseMessage:
          error?.response?.data?.protection?.error ||
          error?.response?.data?.error?.message ||
          error?.response?.data?.message,
        jid,
      },
      "Webhook Vercel indisponible.",
    );
    const text =
      "Je rencontre un problème technique pour le moment. Votre message a bien été reçu ; nous reviendrons vers vous dès que possible.";
    const sent = await socket.sendMessage(jid, { text });
    await saveOutbound(jid, sent, text, "conversation");
  }
}

async function dispatchManualMessage(body) {
  if (!socket?.user)
    throw new Error("La passerelle WhatsApp n’est pas connectée.");
  const jid = normalizeJid(body.jid);
  if (!isDirectChat(jid))
    throw new Error("Seuls les JID de conversation privée sont acceptés.");

  if (body.type === "product_card") {
    const products = await refreshCatalog();
    if (catalogCache.refreshFailed) {
      await sendCatalogUnavailableNotice(jid);
      return;
    }
    const product = products.find(
      (item) => item.id === String(body.product_id || ""),
    );
    if (!product) throw new Error("Produit absent du catalogue courant.");
    const result = await sendProductCard(
      socket,
      jid,
      product,
      BUSINESS_JID,
      body.message || "",
    );
    await saveOutbound(
      jid,
      result,
      `Fiche produit : ${product.title}`,
      "productMessage",
    );
    return;
  }
  if (body.type === "product_list") {
    const products = await refreshCatalog();
    if (catalogCache.refreshFailed) {
      await sendCatalogUnavailableNotice(jid);
      return;
    }
    const chosen = (body.products || [])
      .map(String)
      .map((id) => products.find((item) => item.id === id))
      .filter(Boolean);
    const result = await sendProductList(
      socket,
      jid,
      chosen,
      body.message || "Voici les produits correspondants.",
    );
    await saveOutbound(
      jid,
      result,
      body.message || "Liste de produits",
      "listMessage",
    );
    return;
  }
  if (body.type === "catalog_link") {
    const result = await sendCatalogLink(
      socket,
      jid,
      BUSINESS_JID,
      null,
      body.message || "Voici notre catalogue complet.",
    );
    await saveOutbound(
      jid,
      result,
      body.message || "Lien du catalogue",
      "conversation",
    );
    return;
  }

  const text = String(body.message || "").slice(0, 3000);
  if (!text)
    throw new Error("Le champ message est requis pour un envoi texte.");
  const result = await socket.sendMessage(jid, { text });
  await saveOutbound(jid, result, text, "conversation");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("Corps de requête trop volumineux."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("JSON invalide."));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, whatsappConnected: Boolean(socket?.user) }),
    );
    return;
  }
  if (req.method !== "POST" || req.url !== "/send") {
    res.writeHead(404).end("Not found");
    return;
  }
  if (req.headers.authorization !== `Bearer ${GATEWAY_API_SECRET}`) {
    res.writeHead(401).end("Unauthorized");
    return;
  }

  try {
    const body = await readJson(req);
    await dispatchManualMessage(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    logger.warn({ err: error }, "Requête d’envoi gateway refusée ou échouée.");
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(PORT, "0.0.0.0", () =>
  logger.info({ port: PORT }, "API Gateway prête."),
);

async function connectToWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState();
  let pairingCodeRequested = false;
  socket = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        logger.child({ component: "auth-storage" }),
      ),
    },
    browser: Browsers.ubuntu("Chrome"), // <--- LA CORRECTION EST ICI
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger: logger.child({ component: "baileys" }),
  });

  socket.ev.on("creds.update", () => {
    void saveCreds().catch((error) =>
      logger.error({ err: error }, "Échec d’enregistrement de la session Baileys dans Supabase Storage."),
    );
  });
  socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr && !state.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      const phoneNumber = BUSINESS_JID.split("@")[0].replace(/\D/g, "");
      if (!/^\d{8,15}$/.test(phoneNumber)) {
        logger.error(
          "BUSINESS_JID doit contenir un numéro international valide pour le code d’appairage.",
        );
      } else {
        logger.info(
          "Demande d’un code d’appairage WhatsApp. Sur le téléphone, choisissez Appareils connectés puis Lier avec un numéro de téléphone.",
        );
        void socket
          .requestPairingCode(phoneNumber)
          .then((code) => {
            logger.info({ pairingCode: code }, "CODE D’APPAIRAGE WHATSAPP");
          })
          .catch((error) => {
            logger.error(
              { err: error },
              "Erreur lors de la génération du code d’appairage.",
            );
          });
      }
    }
    if (connection === "open") {
      logger.info({ jid: socket.user?.id }, "WhatsApp Business connecté.");
      void refreshCatalog({ force: true });
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const numericStatusCode = Number(statusCode);
      const shouldReconnect =
        numericStatusCode !== DisconnectReason.loggedOut &&
        numericStatusCode !== 440;
      logger.warn(
        { statusCode, shouldReconnect },
        "Connexion WhatsApp fermée.",
      );
      if (shouldReconnect) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => void connectToWhatsApp(), 5_000);
      } else if (numericStatusCode === 440) {
        socket = undefined;
        logger.fatal(
          "Conflit de session (440). Reconnexion automatique désactivée; résolvez le conflit puis redémarrez le service.",
        );
      } else {
        logger.fatal("WhatsApp a déconnecté la session. Effacement de l’authentification enregistrée.");
        void clearSupabaseAuthState()
          .catch((error) =>
            logger.error(
              { err: error },
              "Impossible d’effacer la session Supabase après déconnexion.",
            ),
          )
          .finally(() => process.exit(1));
      }
    }
  });

  socket.ev.on("messaging-history.set", ({ messages }) => {
    void saveHistory(messages).catch((error) =>
      logger.error(
        { err: error },
        "Échec d’enregistrement de l’historique synchronisé.",
      ),
    );
  });

  socket.ev.on("messages.upsert", ({ messages, type }) => {
    for (const message of messages || []) {
      const jid = normalizeJid(
        message.key?.remoteJid || message.key?.remoteJidAlt,
      );
      if (!isDirectChat(jid) || jid === BUSINESS_JID) continue;
      if (type === "notify" && !message.key?.fromMe) {
        void queueForChat(jid, () => processLiveMessage(message, jid));
      } else {
        void saveInbound(message, jid).catch((error) =>
          logger.error(
            { err: error, jid },
            "Échec d’enregistrement d’un message upsert.",
          ),
        );
      }
    }
  });
}

void connectToWhatsApp().catch((error) => {
  logger.fatal({ err: error }, "Impossible de démarrer Baileys.");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    clearTimeout(reconnectTimer);
    server.close();
    try {
      await socket?.end();
    } catch {
      /* fermeture best-effort */
    }
    process.exit(0);
  });
}
