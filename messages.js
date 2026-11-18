import { normalizeMessageContent } from "@whiskeysockets/baileys";
import { formatPrice, normalizeJid } from "./catalog.js";

/**
 * Lecture pure des messages WhatsApp (contenu, texte, opt-out, destinataire).
 * Ces helpers vivent hors de index.js parce qu’importer index.js démarre le
 * serveur HTTP : sans ce module, ils ne seraient pas testables.
 */

/** Types d’événements qui ne portent jamais une demande utilisateur. */
const NON_USER_MESSAGE_TYPES = new Set([
  "messageContextInfo",
  "protocolMessage",
  "senderKeyDistributionMessage",
  "reactionMessage",
  "pollUpdateMessage",
  "keepInChatMessage",
  "eventNotificationMessage",
  "call",
]);

export const OPT_OUT_PATTERN =
  /^(stop|arret|arrêt|arreter|arrêter|desabonner|désabonner|desinscrire|désinscrire|unsubscribe)\b/i;

export function messageContent(message) {
  return normalizeMessageContent(message?.message) || message?.message || {};
}

export function messageBody(message) {
  const content = messageContent(message);
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.productMessage?.product?.title ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedId ||
    content.interactiveResponseMessage?.body?.text ||
    content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    ""
  );
}

export function isNonUserMessageWithoutText(message) {
  const contentTypes = Object.keys(messageContent(message)).filter(
    (type) => type !== "messageContextInfo",
  );
  return (
    contentTypes.length === 0 ||
    contentTypes.every((type) => NON_USER_MESSAGE_TYPES.has(type))
  );
}

export function isOptOutMessage(body) {
  return OPT_OUT_PATTERN.test(String(body || "").trim());
}

/**
 * WhatsApp peut livrer un même contact sous deux identités (@lid et le JID
 * téléphone). On privilégie systématiquement le JID PN quand il est fourni,
 * sinon l’historique, les contacts et les relances se retrouvent éclatés entre
 * deux conversations distinctes.
 */
export function canonicalContactJid(message) {
  const primary = normalizeJid(message?.key?.remoteJid || "");
  const alt = normalizeJid(message?.key?.remoteJidAlt || "");
  if (primary.endsWith("@lid") && alt.endsWith("@s.whatsapp.net")) return alt;
  return primary || alt;
}

/** Lien produit ou catalogue complet, ou null sans numéro d’entreprise. */
export function businessLink(productId = null, businessJid) {
  const digits = String(businessJid || "").split("@")[0];
  if (!digits) return null;
  return productId
    ? `https://wa.me/p/${encodeURIComponent(productId)}/${digits}`
    : `https://wa.me/c/${digits}`;
}

/** Repli texte d’une liste interactive refusée par WhatsApp. */
export function buildProductText(products, message, businessJid) {
  const lines = [message || "Voici les produits correspondants."];
  products.forEach((product, index) => {
    const details = [product.description, formatPrice(product)]
      .filter(Boolean)
      .join(" — ");
    lines.push(`${index + 1}. ${product.title}${details ? ` — ${details}` : ""}`);
    const link = businessLink(product.id, businessJid);
    if (link) lines.push(link);
    lines.push("");
  });
  return lines.join("\n").trim().slice(0, 4000);
}
