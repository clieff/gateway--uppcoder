import "dotenv/config";
import http from "node:http";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import axios from "axios";
import pino from "pino";
import {
  saveMessage,
  saveMessages,
  setFollowupOptIn,
  updateContact,
} from "./db.js";
import {
  clearSupabaseAuthState,
  flushAuthState,
  useSupabaseAuthState,
} from "./auth-state.js";
import {
  getCatalogProducts,
  normalizeJid,
  sendCatalogLink,
  sendProductCard,
  sendProductList,
  syncCatalogFromWhatsApp,
} from "./catalog.js";
import {
  buildProductText,
  businessLink,
  canonicalContactJid,
  isNonUserMessageWithoutText,
  isOptOutMessage,
  messageBody,
  messageContent,
} from "./messages.js";

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
// Le cerveau répond en 2 x 15 s au pire; 45 s laisse une marge sous les 60 s de Vercel.
const WEBHOOK_TIMEOUT_MS = 45_000;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// libsignal écrit des objets de session complets sur console, avec des clés privées.
// On garde le message de diagnostic, mais on retire l’objet sensible des logs Render.
const sensitiveSignalLogMessages = new Set([
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
  "Session already closed",
]);
for (const method of ["info", "warn"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    if (sensitiveSignalLogMessages.has(args[0])) {
      original(args[0], "[détails de session masqués]");
      return;
    }
    original(...args);
  };
}

const catalogCache = {
  products: [],
  refreshedAt: 0,
  refreshPromise: null,
  refreshTimedOut: false,
  retryAfter: 0,
  refreshFailed: false,
};
const replyQueues = new Map();
const inboundQueues = new Map();
const recentInboundMessageIds = new Map();
const INBOUND_MESSAGE_DEDUP_TTL_MS = 10 * 60_000;
const MAX_RECENT_INBOUND_MESSAGE_IDS = 5_000;
let socket;
let connecting = false;
let reconnectTimer;
let reconnectAttempt = 0;
let connectedAt;
let shuttingDown = false;
let catalogSyncPromise = null;
let whatsappPhase = "booting";
let whatsappPhaseUpdatedAt = Date.now();
let whatsappProgress = { phase: whatsappPhase };

function setWhatsAppPhase(phase, details = {}) {
  whatsappPhase = phase;
  whatsappPhaseUpdatedAt = Date.now();
  whatsappProgress = { phase, ...details };
}

function safeErrorDetails(error) {
  const responseData = error?.response?.data;
  const responseMessage =
    responseData?.protection?.error ||
    responseData?.error?.message ||
    responseData?.message;

  return {
    message: error?.message || String(error),
    code: error?.code,
    status: error?.response?.status,
    responseMessage:
      typeof responseMessage === "string"
        ? responseMessage.slice(0, 500)
        : undefined,
    vercelRequestId:
      error?.response?.headers?.["x-vercel-id"] ||
      error?.response?.headers?.["x-vercel-error"],
  };
}

/**
 * Les écouteurs Baileys sont synchrones : une promesse rejetée et non capturée
 * ferait planter le processus et couperait la passerelle, donc plus aucune
 * réponse WhatsApp. Toute tâche détachée passe par ce garde-fou.
 */
function runInBackground(label, task, context = {}) {
  Promise.resolve()
    .then(task)
    .catch((error) =>
      logger.error(
        { err: safeErrorDetails(error), ...context },
        `Tâche d’arrière-plan interrompue : ${label}.`,
      ),
    );
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

function claimInboundMessageId(message) {
  const messageId = message?.key?.id;
  if (!messageId) return true;

  const now = Date.now();
  for (const [id, expiresAt] of recentInboundMessageIds) {
    if (expiresAt > now) break;
    recentInboundMessageIds.delete(id);
  }

  if (recentInboundMessageIds.has(messageId)) return false;
  if (recentInboundMessageIds.size >= MAX_RECENT_INBOUND_MESSAGE_IDS) {
    const oldestId = recentInboundMessageIds.keys().next().value;
    if (oldestId) recentInboundMessageIds.delete(oldestId);
  }
  recentInboundMessageIds.set(
    messageId,
    now + INBOUND_MESSAGE_DEDUP_TTL_MS,
  );
  return true;
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
  if (catalogCache.refreshPromise && catalogCache.refreshTimedOut)
    return catalogCache.products;

  if (!catalogCache.refreshPromise) {
    if (!force && now < catalogCache.retryAfter)
      return catalogCache.products;

    const catalogRead = Promise.resolve()
      .then(() => getCatalogProducts())
      .then((products) => {
        catalogCache.products = products;
        catalogCache.refreshedAt = Date.now();
        catalogCache.retryAfter = 0;
        catalogCache.refreshFailed = false;
        logger.info(
          {
            products: products.length,
            productsWithImages: products.filter((product) => product.imageUrl).length,
          },
          "Catalogue Supabase chargé.",
        );
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
          "Catalogue indisponible; le dernier cache est conservé.",
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
      "Catalogue > 3 s; le dernier catalogue connu est utilisé, l’actualisation continue en arrière-plan.",
    );
    return catalogCache.products;
  }

  return result;
}

async function syncCatalog(reason) {
  if (catalogSyncPromise) return catalogSyncPromise;

  catalogSyncPromise = (async () => {
    try {
      const result = await syncCatalogFromWhatsApp(socket, {
        businessJid: BUSINESS_JID,
      });
      logger.info(
        { ...result, reason },
        "Catalogue natif WhatsApp synchronisé dans Supabase.",
      );
      if (result.synced) {
        catalogCache.retryAfter = 0;
        catalogCache.refreshFailed = false;
      } else {
        logger.warn(
          { reason },
          "Catalogue natif WhatsApp vide ou incomplet; les produits Supabase existants sont conservés.",
        );
      }
    } catch (error) {
      logger.warn(
        { err: safeErrorDetails(error), reason },
        "Synchronisation du catalogue natif impossible; les produits Supabase existants sont utilisés.",
      );
    } finally {
      await refreshCatalog({ force: true });
      catalogSyncPromise = null;
    }
  })();

  return catalogSyncPromise;
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
      { err: safeErrorDetails(error), jid, messageId: message.key?.id },
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
        { err: safeErrorDetails(error), jid },
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
    const jid = canonicalContactJid(message);
    if (!message.key?.id || !isDirectChat(jid) || jid === BUSINESS_JID) continue;
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
        {
          err: safeErrorDetails(error),
          offset,
          batchSize: Math.min(100, records.length - offset),
        },
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
          { err: safeErrorDetails(error), jid: contact.jid },
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
      { err: safeErrorDetails(error), jid },
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
      { err: safeErrorDetails(error), jid },
      "Impossible d’envoyer le message de secours du catalogue.",
    );
    return false;
  }
}

/**
 * Envoie l’action décidée par le cerveau. `strict` fait échouer un envoi
 * manuel sur un id inconnu au lieu d’envoyer un message de repli.
 */
async function sendAction(jid, action, products, { strict = false } = {}) {
  const message = String(action?.message || "").slice(0, 3000);

  if (action?.type === "product_card") {
    const product = products.find(
      (item) => item.id === String(action.product_id || ""),
    );
    if (!product) {
      if (strict) throw new Error("Produit absent du catalogue courant.");
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
    const chosen = [...new Set(selectedIds)]
      .map((id) => products.find((item) => item.id === id))
      .filter(Boolean)
      .slice(0, 10);
    if (!chosen.length) {
      if (strict) throw new Error("Aucun produit correspondant dans le catalogue courant.");
      const text =
        "Je n’ai pas trouvé de produit correspondant dans le catalogue actuel. Vous pouvez consulter le catalogue complet.";
      const sent = await socket.sendMessage(jid, { text });
      await saveOutbound(jid, sent, text, "conversation");
      return;
    }
    const label = message || "Voici les produits correspondants.";
    let result;
    let messageType = "listMessage";
    try {
      result = await sendProductList(socket, jid, chosen, label);
    } catch (error) {
      // Les listes interactives peuvent être refusées ou ignorées par WhatsApp :
      // on garantit un envoi texte équivalent plutôt qu’un silence.
      logger.warn(
        { err: safeErrorDetails(error), jid },
        "Liste interactive refusée; repli en message texte.",
      );
      result = await socket.sendMessage(jid, {
        text: buildProductText(chosen, label, BUSINESS_JID),
      });
      messageType = "conversation";
    }
    await saveOutbound(
      jid,
      result,
      `${label} — ${chosen.map((item) => item.title).join(", ")}`,
      messageType,
    );
    return;
  }

  if (action?.type === "product_gallery") {
    const selectedIds = Array.isArray(action.products)
      ? action.products.map(String)
      : [];
    const chosen = [...new Set(selectedIds)]
      .map((id) => products.find((item) => item.id === id))
      .filter((item) => item?.imageUrl)
      .slice(0, 5);

    if (!chosen.length) {
      const text = `${message || "Je n’ai pas de photos de produits à afficher ici."} ${businessLink(null, BUSINESS_JID) || ""}`.trim();
      const sent = await socket.sendMessage(jid, { text });
      await saveOutbound(jid, sent, text, "conversation");
      return;
    }

    let sentCount = 0;
    for (const [index, product] of chosen.entries()) {
      try {
        const result = await sendProductCard(
          socket,
          jid,
          product,
          BUSINESS_JID,
          index === 0 ? message || "Voici quelques produits avec leurs photos." : "",
        );
        await saveOutbound(
          jid,
          result,
          `Fiche produit : ${product.title}`,
          "productMessage",
        );
        sentCount += 1;
      } catch (error) {
        logger.warn(
          { err: safeErrorDetails(error), jid, productId: product.id },
          "Impossible d’envoyer une fiche produit de la galerie.",
        );
      }
    }

    if (!sentCount) {
      const text = `Je n’ai pas réussi à afficher les photos. Voici le catalogue complet : ${businessLink(null, BUSINESS_JID) || ""}`.trim();
      const sent = await socket.sendMessage(jid, { text });
      await saveOutbound(jid, sent, text, "conversation");
    }
    return;
  }

  if (action?.type === "catalog_link") {
    const catalogUrl = businessLink(null, BUSINESS_JID) || "";
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
      [message.replaceAll(catalogUrl, "").trim(), catalogUrl]
        .filter(Boolean)
        .join("\n"),
      "conversation",
    );
    return;
  }

  const text =
    message || "Merci pour votre message. Comment puis-je vous aider ?";
  const sent = await socket.sendMessage(jid, { text });
  await saveOutbound(jid, sent, text, "conversation");
}

async function handleOptOut(jid) {
  let text;
  try {
    await setFollowupOptIn(jid, false);
    logger.info({ jid }, "Contact désinscrit des relances.");
    text =
      "C’est noté : votre désinscription est enregistrée. Vous ne recevrez plus nos messages de relance. Vous pouvez nous écrire à tout moment.";
  } catch (error) {
    logger.error(
      { err: safeErrorDetails(error), jid },
      "Désinscription du contact non enregistrée.",
    );
    text =
      "Votre demande de désinscription n’a pas pu être enregistrée à cause d’un problème technique. Merci de réessayer plus tard ou de contacter notre équipe.";
  }
  const sent = await socket.sendMessage(jid, { text });
  await saveOutbound(jid, sent, text, "conversation");
}

async function requestBrainReply(jid, job) {
  const products = await refreshCatalog();
  const publicProducts = products.map(
    ({ id, title, description, price, currency, imageUrl }) => ({
      id,
      title,
      description,
      price,
      currency,
      hasImage: Boolean(imageUrl),
    }),
  );

  try {
    const response = await axios.post(
      WEBHOOK_URL,
      {
        jid,
        messageId: job.messageId,
        message: job.content,
        catalogProducts: publicProducts,
      },
      {
        timeout: WEBHOOK_TIMEOUT_MS,
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
        jid,
        messageId: job.messageId,
      },
      "Webhook Vercel indisponible.",
    );
    const text =
      "Je rencontre un problème technique pour le moment. Votre message a bien été reçu ; nous reviendrons vers vous dès que possible.";
    const sent = await socket.sendMessage(jid, { text });
    await saveOutbound(jid, sent, text, "conversation");
  }
}

/**
 * Une seule requête au cerveau par conversation à la fois. Si plusieurs
 * messages arrivent pendant le traitement, le plus récent remplace les autres :
 * l’historique complet est déjà enregistré, donc le cerveau voit tous les
 * messages sans payer un appel par message.
 */
function enqueueReply(jid, job) {
  let state = replyQueues.get(jid);
  if (!state) {
    state = { running: false, pending: null };
    replyQueues.set(jid, state);
  }

  if (state.running) {
    state.pending = job;
    logger.debug({ jid }, "Message suivant mis en attente sur cette conversation.");
    return;
  }

  runInBackground("file de réponse", () => drainReplies(jid, state, job), {
    jid,
  });
}

/** Persiste les messages d’un même chat dans l’ordre avant de lancer le cerveau. */
function enqueueInboundMessage(jid, message) {
  const previous = inboundQueues.get(jid) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => processLiveMessage(message, jid));
  inboundQueues.set(jid, current);

  current
    .finally(() => {
      if (inboundQueues.get(jid) === current) inboundQueues.delete(jid);
    })
    .catch(() => undefined);

  runInBackground("traitement du message reçu", () => current, {
    jid,
    messageId: message.key?.id,
  });
}

async function drainReplies(jid, state, firstJob) {
  state.running = true;
  let job = firstJob;
  try {
    while (job) {
      try {
        await requestBrainReply(jid, job);
      } catch (error) {
        logger.error(
          { err: safeErrorDetails(error), jid },
          "Échec du traitement du message.",
        );
      }
      job = state.pending;
      state.pending = null;
    }
  } finally {
    // Sans ce finally, une erreur inattendue laisserait la conversation
    // marquée « en cours » et les messages suivants seraient ignorés.
    state.running = false;
    replyQueues.delete(jid);
  }
}

async function processLiveMessage(message, jid) {
  if (message.key?.fromMe) return;
  if (!claimInboundMessageId(message)) {
    logger.debug(
      { messageId: message.key?.id, jid },
      "Événement WhatsApp dupliqué ignoré.",
    );
    return;
  }

  const body = messageBody(message).trim().slice(0, 16000);
  if (!body && isNonUserMessageWithoutText(message)) {
    logger.debug(
      {
        jid,
        messageId: message.key?.id,
        messageTypes: Object.keys(messageContent(message)),
      },
      "Événement WhatsApp sans contenu utilisateur ignoré.",
    );
    return;
  }

  let inserted = true;
  try {
    inserted = await saveInbound(message, jid);
  } catch (error) {
    // Même une erreur inattendue pendant la sauvegarde ne doit pas bloquer Vercel.
    logger.error(
      { err: safeErrorDetails(error), jid, messageId: message.key?.id },
      "Échec de sauvegarde du message entrant; le traitement continue vers Vercel.",
    );
  }
  if (!inserted) return;

  if (isOptOutMessage(body)) {
    await handleOptOut(jid);
    return;
  }

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
    if (!products.length && catalogCache.refreshFailed) {
      await sendCatalogUnavailableNotice(jid);
      return;
    }
    const text =
      "Ce produit n’est plus disponible dans notre catalogue. Souhaitez-vous que je vous montre les produits actuels ?";
    const sent = await socket.sendMessage(jid, { text });
    await saveOutbound(jid, sent, text, "conversation");
    return;
  }

  if (!body) {
    const text =
      "Je peux traiter les messages écrits pour le moment. Merci de m’envoyer votre demande en texte.";
    const sent = await socket.sendMessage(jid, { text });
    await saveOutbound(jid, sent, text, "conversation");
    return;
  }

  enqueueReply(jid, { messageId: message.key.id, content: body });
}

async function dispatchManualMessage(body) {
  if (!socket?.user)
    throw new Error("La passerelle WhatsApp n’est pas connectée.");
  const jid = normalizeJid(body.jid);
  if (!isDirectChat(jid))
    throw new Error("Seuls les JID de conversation privée sont acceptés.");

  const type = String(body.type || "text");
  if (["product_card", "product_list", "product_gallery", "catalog_link"].includes(type)) {
    const products = await refreshCatalog();
    if (!products.length && catalogCache.refreshFailed) {
      await sendCatalogUnavailableNotice(jid);
      return;
    }
    await sendAction(
      jid,
      {
        type,
        message: body.message,
        product_id: body.product_id,
        products: body.products,
      },
      products,
      { strict: true },
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
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify({
        ok: true,
        whatsappConnected: Boolean(socket?.user),
        whatsappPhase,
        whatsappPhaseUpdatedAt: new Date(whatsappPhaseUpdatedAt).toISOString(),
        startupProgress: whatsappProgress,
        connectedAt: connectedAt ? connectedAt.toISOString() : null,
        reconnectAttempt,
        uptimeSeconds: Math.round(process.uptime()),
        catalog: {
          products: catalogCache.products.length,
          productsWithImages: catalogCache.products.filter((product) => product.imageUrl).length,
          refreshedAt: catalogCache.refreshedAt
            ? new Date(catalogCache.refreshedAt).toISOString()
            : null,
          failed: catalogCache.refreshFailed,
        },
      }),
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
    logger.warn({ err: safeErrorDetails(error) }, "Requête d’envoi gateway refusée ou échouée.");
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

server.on("error", (error) => {
  logger.fatal({ err: safeErrorDetails(error) }, "Serveur HTTP en erreur.");
  process.exit(1);
});

function scheduleReconnect() {
  if (shuttingDown) return;

  reconnectAttempt += 1;
  const base = Math.min(
    RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1),
    RECONNECT_MAX_MS,
  );
  const delay = Math.round(base * (0.7 + Math.random() * 0.6));

  setWhatsAppPhase("reconnect_wait");
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(
    () => runInBackground("reconnexion WhatsApp", connectToWhatsApp),
    delay,
  );
  logger.warn(
    { attempt: reconnectAttempt, delayMs: delay },
    "Reconnexion WhatsApp planifiée.",
  );
}

async function connectToWhatsApp() {
  if (shuttingDown || connecting) return;
  connecting = true;

  try {
    setWhatsAppPhase("loading_session");
    logger.info(
      { attempt: reconnectAttempt + 1 },
      "Chargement de la session WhatsApp depuis Supabase Storage.",
    );
    const authStartedAt = Date.now();
    const { state, saveCreds } = await useSupabaseAuthState({
      onProgress: ({ phase, ...details }) => {
        setWhatsAppPhase(phase, details);
        logger.info(
          { phase, ...details },
          "Progression du chargement de la session WhatsApp.",
        );
      },
    });
    logger.info(
      { durationMs: Date.now() - authStartedAt },
      "Session WhatsApp chargée.",
    );

    setWhatsAppPhase("creating_socket");
    logger.info("Création du socket Baileys.");
    let pairingCodeRequested = false;
    socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          logger.child({ component: "auth-storage" }),
        ),
      },
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: logger.child({ component: "baileys" }),
    });
    setWhatsAppPhase("waiting_for_whatsapp");
    logger.info("Socket Baileys créé; attente de la connexion WhatsApp.");

    socket.ev.on("creds.update", () => {
      void saveCreds().catch((error) =>
        logger.error(
          { err: safeErrorDetails(error) },
          "Échec d’enregistrement de la session Baileys dans Supabase Storage.",
        ),
      );
    });

    socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (connection === "connecting") {
        setWhatsAppPhase("connecting_to_whatsapp");
        logger.info("Baileys tente la connexion à WhatsApp.");
      }
      if (qr && !state.creds.registered && !pairingCodeRequested) {
        pairingCodeRequested = true;
        setWhatsAppPhase("pairing_code_requested");
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
                { err: safeErrorDetails(error) },
                "Erreur lors de la génération du code d’appairage.",
              );
            });
        }
      }
      if (connection === "open") {
        connectedAt = new Date();
        reconnectAttempt = 0;
        setWhatsAppPhase("connected");
        logger.info({ jid: socket.user?.id }, "WhatsApp Business connecté.");
        runInBackground("synchronisation du catalogue", () =>
          syncCatalog("connexion"),
        );
      }
      if (connection === "close") {
        connectedAt = undefined;
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
          scheduleReconnect();
        } else if (numericStatusCode === 440) {
          socket = undefined;
          setWhatsAppPhase("session_conflict_440");
          logger.fatal(
            "Conflit de session (440). Reconnexion automatique désactivée; résolvez le conflit puis redémarrez le service.",
          );
        } else {
          setWhatsAppPhase("logged_out");
          logger.fatal("WhatsApp a déconnecté la session. Effacement de l’authentification enregistrée.");
          void clearSupabaseAuthState()
            .catch((error) =>
              logger.error(
                { err: safeErrorDetails(error) },
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
          { err: safeErrorDetails(error) },
          "Échec d’enregistrement de l’historique synchronisé.",
        ),
      );
    });

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      for (const message of messages || []) {
        const jid = canonicalContactJid(message);
        if (!isDirectChat(jid) || jid === BUSINESS_JID) continue;
        if (type === "notify" && !message.key?.fromMe) {
          enqueueInboundMessage(jid, message);
        } else {
          void saveInbound(message, jid).catch((error) =>
            logger.error(
              { err: safeErrorDetails(error), jid },
              "Échec d’enregistrement d’un message upsert.",
            ),
          );
        }
      }
    });
  } catch (error) {
    connectedAt = undefined;
    setWhatsAppPhase("initialization_failed");
    logger.error(
      { err: safeErrorDetails(error) },
      "Échec de l’initialisation WhatsApp; l’API reste active et une nouvelle tentative est planifiée.",
    );
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  clearTimeout(reconnectTimer);
  server.close();

  try {
    await flushAuthState();
  } catch (error) {
    logger.error(
      { err: safeErrorDetails(error) },
      "Session Baileys non enregistrée avant l’arrêt.",
    );
  }
  try {
    await socket?.end();
  } catch {
    /* fermeture best-effort */
  }
  process.exit(exitCode);
}

async function main() {
  setWhatsAppPhase("http_starting");
  server.listen(PORT, "0.0.0.0", () =>
    logger.info({ port: PORT }, "API Gateway prête."),
  );
  await connectToWhatsApp();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () =>
    runInBackground("arrêt de la passerelle", () => shutdown(0)),
  );
}

void main().catch((error) => {
  logger.fatal({ err: safeErrorDetails(error) }, "Impossible de démarrer la passerelle.");
  process.exit(1);
});
