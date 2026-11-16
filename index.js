import "dotenv/config";
import http from "node:http";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import { timingSafeEqual } from "node:crypto";
import axios from "axios";
import pino from "pino";
import QRCode from "qrcode";
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

const WEBHOOK_URL = process.env.VERCEL_WEBHOOK_URL;
const GATEWAY_API_SECRET = process.env.GATEWAY_API_SECRET;
const QR_VIEW_PASSWORD = process.env.QR_VIEW_PASSWORD || GATEWAY_API_SECRET;
const BUSINESS_JID = normalizeJid(process.env.BUSINESS_JID);
const PORT = Number(
  process.env.PORT ||
    process.env.APP_PORT ||
    process.env.GATEWAY_PORT ||
    3000,
);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const catalogCache = {
  products: [],
  refreshedAt: 0,
  refreshPromise: null,
  retryAfter: 0,
  refreshFailed: false,
};
const chatQueues = new Map();
let socket;
let reconnectTimer;
let currentQr;

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

function isQrViewerAuthorized(req) {
  const match = /^Basic\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!match) return false;

  let credentials;
  try {
    credentials = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = credentials.indexOf(":");
  if (separator < 0 || credentials.slice(0, separator) !== "qr") return false;

  const suppliedPassword = Buffer.from(credentials.slice(separator + 1));
  const expectedPassword = Buffer.from(QR_VIEW_PASSWORD || "");
  return (
    suppliedPassword.length === expectedPassword.length &&
    timingSafeEqual(suppliedPassword, expectedPassword)
  );
}

async function refreshCatalog({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - catalogCache.refreshedAt < 60_000)
    return catalogCache.products;
  if (catalogCache.refreshPromise) return catalogCache.refreshPromise;
  if (now < catalogCache.retryAfter) return catalogCache.products;

  const pending = (async () => {
    let timeout;
    try {
      const result = await Promise.race([
        getCatalogProducts(socket),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error("Délai maximal de lecture du catalogue dépassé."),
              ),
            30_000,
          );
        }),
      ]);
      catalogCache.products = result;
      catalogCache.refreshedAt = Date.now();
      catalogCache.retryAfter = 0;
      catalogCache.refreshFailed = false;
      return result;
    } catch (error) {
      catalogCache.retryAfter = Date.now() + 60_000;
      catalogCache.refreshFailed = true;
      logger.warn(
        { err: error, cachedProducts: catalogCache.products.length },
        "Catalogue natif indisponible; le dernier cache est conservé.",
      );
      return catalogCache.products;
    } finally {
      clearTimeout(timeout);
    }
  })();
  catalogCache.refreshPromise = pending;
  try {
    return await pending;
  } finally {
    if (catalogCache.refreshPromise === pending)
      catalogCache.refreshPromise = null;
  }
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
    if (catalogCache.refreshFailed) {
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
  const catalogNoticeSent = catalogCache.refreshFailed
    ? await sendCatalogUnavailableNotice(jid)
    : false;
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
        headers: { Authorization: `Bearer ${GATEWAY_API_SECRET}` },
      },
    );
    await sendAction(jid, response.data, products);
  } catch (error) {
    logger.error({ err: error, jid }, "Webhook Vercel indisponible.");
    if (!catalogNoticeSent) {
      const text =
        "Je rencontre un problème technique pour le moment. Votre message a bien été reçu ; nous reviendrons vers vous dès que possible.";
      const sent = await socket.sendMessage(jid, { text });
      await saveOutbound(jid, sent, text, "conversation");
    }
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
  if (req.method === "GET" && req.url === "/qr") {
    if (!isQrViewerAuthorized(req)) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Baileys QR", charset="UTF-8"',
        "Cache-Control": "no-store",
      });
      res.end("Authentification requise.");
      return;
    }
    if (!currentQr) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Aucun QR code WhatsApp n’est actuellement disponible.");
      return;
    }

    try {
      const image = await QRCode.toBuffer(currentQr, {
        type: "png",
        width: 360,
        margin: 2,
        errorCorrectionLevel: "M",
      });
      res.writeHead(200, {
        "content-type": "image/png",
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
      });
      res.end(image);
    } catch (error) {
      logger.error({ err: error }, "Impossible de générer l’image du QR code.");
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Impossible de générer le QR code.");
    }
    return;
  }

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
  socket = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        logger.child({ component: "auth-storage" }),
      ),
    },
    browser: Browsers.ubuntu("Chrome"), // <--- LA CORRECTION EST ICI
    syncFullHistory: true,
    markOnlineOnConnect: false,
    logger: logger.child({ component: "baileys" }),
  });

  socket.ev.on("creds.update", () => {
    void saveCreds().catch((error) =>
      logger.error({ err: error }, "Échec d’enregistrement de la session Baileys dans Supabase Storage."),
    );
  });
  socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQr = qr;
      const publicBaseUrl = (
        process.env.RENDER_EXTERNAL_URL ||
        process.env.GATEWAY_PUBLIC_URL ||
        process.env.GATEWAY_API_URL ||
        ""
      ).replace(/\/+$/, "");
      if (publicBaseUrl) {
        logger.info(
          `QR code temporaire : ${publicBaseUrl}/qr (utilisateur : qr; mot de passe : QR_VIEW_PASSWORD, ou GATEWAY_API_SECRET par défaut).`,
        );
      } else {
        logger.info(
          "QR code reçu. Définissez GATEWAY_PUBLIC_URL pour obtenir un lien complet vers /qr.",
        );
      }
    }
    if (connection === "open") {
      currentQr = undefined;
      logger.info({ jid: socket.user?.id }, "WhatsApp Business connecté.");
      void refreshCatalog({ force: true });
    }
    if (connection === "close") {
      currentQr = undefined;
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
