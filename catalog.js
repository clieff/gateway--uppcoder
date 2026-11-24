import 'dotenv/config';
import { supabase } from './db.js';

const BUSINESS_JID = process.env.BUSINESS_JID;
const MAX_CATALOG_PRODUCTS = 50;
const CATALOG_COLUMNS =
  'id,title,description,price,currency,retailer_id,url,image_url';
// Lecture du catalogue natif : 50 produits par page, 20 pages au maximum, et
// 30 s d’attente par page (Baileys attend 60 s par défaut).
const CATALOG_SYNC_PAGE_SIZE = 50;
const CATALOG_SYNC_MAX_PAGES = 20;
// Ce compte Business ne reçoit souvent aucune réponse à l’IQ w:biz:catalog
// (WhiskeySockets/Baileys#2717) : un délai court évite d’attendre 30 s pour rien
// à chaque connexion avant de retomber sur le catalogue Supabase.
const CATALOG_SYNC_TIMEOUT_MS = 10_000;
// Taille des lots de la relecture des images existantes (limite d’URL PostgREST).
const CATALOG_LOOKUP_CHUNK_SIZE = 100;

function normalizeJid(jid) {
  if (!jid) return '';
  const value = String(jid).trim();
  if (value.includes('@')) return value.replace(/:\d+@/, '@');
  return `${value.replace(/\D/g, '')}@s.whatsapp.net`;
}

function getImageUrl(product) {
  const images = product?.media?.images || product?.imageUrls;
  if (typeof images === 'string') return images;
  if (Array.isArray(images)) {
    const first = images[0];
    if (typeof first === 'string') return first;
    return first?.original_image_url
      || first?.request_image_url
      || first?.original
      || first?.url
      || null;
  }
  if (images && typeof images === 'object') return images.requested || images.original || images.url;
  return product?.imageUrl || product?.image || product?.thumbnailUrl || null;
}

function normalizeProduct(product) {
  const id = String(product?.id || product?.productId || '');
  const title = String(product?.name || product?.title || '');
  const price = product?.price == null || product.price === '' ? null : Number(product.price);
  const hidden = product?.isHidden ?? product?.is_hidden;
  const isHidden = hidden === true
    || ['true', '1', 'ishidden_true'].includes(String(hidden).toLowerCase());

  if (!id || !title || isHidden) return null;

  return {
    id,
    title,
    description: String(product?.description || ''),
    price: price != null && Number.isFinite(price) ? price : null,
    currency: String(product?.currency || product?.currencyCode || ''),
    retailerId: String(product?.retailerId || product?.retailer_id || ''),
    url: String(product?.url || ''),
    imageUrl: getImageUrl(product),
  };
}

/** Prix lisible pour les messages texte et les lignes de liste. */
function formatPrice(product) {
  if (product?.price == null || product.price === '') return '';
  const amount = Number(product.price);
  if (!Number.isFinite(amount)) return '';
  const formatted = new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 2,
  }).format(amount);
  return [formatted, String(product.currency || '')].filter(Boolean).join(' ');
}

/**
 * Lit le catalogue depuis la table public.products (source de vérité du bot).
 * La requête graph.whatsapp.com/graphql/catalog utilisée par WhatsApp Web a été
 * abandonnée : elle exige une instance authentifiée et renvoie field_exception
 * pour ce compte, quel que soit le jeton fourni.
 */
export async function getCatalogProducts() {
  const { data, error } = await supabase
    .from('products')
    .select(CATALOG_COLUMNS)
    .eq('is_active', true)
    .order('title', { ascending: true })
    .limit(MAX_CATALOG_PRODUCTS);

  if (error) {
    throw new Error(`Lecture du catalogue Supabase impossible : ${error.message}`);
  }

  return (data || [])
    .map((row) =>
      normalizeProduct({
        id: row.id,
        title: row.title,
        description: row.description,
        price: row.price,
        currency: row.currency,
        retailerId: row.retailer_id,
        url: row.url,
        imageUrl: row.image_url,
      }),
    )
    .filter(Boolean)
    .slice(0, MAX_CATALOG_PRODUCTS);
}

/**
 * Conserve l’image déjà enregistrée (bucket Supabase Storage ou saisie manuelle)
 * quand le catalogue natif WhatsApp ne fournit pas d’image pour ce produit.
 */
function preserveExistingImages(rows, existingRows) {
  const existing = new Map(
    (existingRows || []).map((row) => [String(row.id), row.image_url || null]),
  );
  return rows.map((row) => ({
    ...row,
    image_url: row.image_url || existing.get(String(row.id)) || null,
  }));
}

function toProductRow(product) {
  return {
    id: product.id,
    title: product.title,
    description: product.description || '',
    price: product.price,
    currency: product.currency || '',
    retailer_id: product.retailerId || '',
    url: product.url || '',
    image_url: product.imageUrl || null,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Lit le catalogue natif du compte Business via la requête w:biz:catalog de
 * Baileys, puis l’enregistre dans public.products. La synchronisation est
 * strictement additive : elle ne désactive jamais un produit, donc les produits
 * saisis à la main restent actifs même s’ils sont absents du catalogue WhatsApp.
 * De même, une image_url déjà enregistrée (bucket Supabase Storage) est
 * conservée quand le produit natif n’en fournit pas.
 */
export async function syncCatalogFromWhatsApp(
  sock,
  { businessJid = BUSINESS_JID } = {},
) {
  if (!businessJid) {
    throw new Error('BUSINESS_JID doit identifier le compte Business propriétaire du catalogue.');
  }
  if (typeof sock?.getCatalog !== 'function') {
    throw new Error('Cette version de Baileys ne propose pas la lecture du catalogue natif.');
  }

  const collected = [];
  let cursor;
  let complete = false;

  for (let page = 0; page < CATALOG_SYNC_MAX_PAGES; page += 1) {
    const result = await withTimeout(
      sock.getCatalog({
        jid: businessJid,
        limit: CATALOG_SYNC_PAGE_SIZE,
        cursor,
      }),
      CATALOG_SYNC_TIMEOUT_MS,
      'Catalogue natif : WhatsApp n’a pas répondu dans le délai imparti.',
    );
    const products = Array.isArray(result?.products) ? result.products : [];
    collected.push(...products);
    cursor = result?.nextPageCursor;
    if (!cursor) {
      complete = true;
      break;
    }
    if (!products.length) break;
  }

  const unique = new Map();
  for (const product of collected.map(normalizeProduct).filter(Boolean)) {
    unique.set(product.id, product);
  }
  const rows = [...unique.values()].map(toProductRow);

  if (!rows.length) {
    return { synced: 0, productsWithImages: 0, deactivated: 0, complete };
  }

  const ids = rows.map((row) => row.id);
  const existingRows = [];
  for (let index = 0; index < ids.length; index += CATALOG_LOOKUP_CHUNK_SIZE) {
    const { data, error: readError } = await supabase
      .from('products')
      .select('id,image_url')
      .in('id', ids.slice(index, index + CATALOG_LOOKUP_CHUNK_SIZE));
    if (readError) {
      throw new Error(`Lecture des images existantes impossible : ${readError.message}`);
    }
    existingRows.push(...(data || []));
  }
  const rowsToWrite = preserveExistingImages(rows, existingRows);

  const { error: upsertError } = await supabase
    .from('products')
    .upsert(rowsToWrite, { onConflict: 'id' });
  if (upsertError) {
    throw new Error(`Enregistrement du catalogue dans Supabase impossible : ${upsertError.message}`);
  }

  // Aucun produit n’est jamais désactivé : la synchro n’est pas destructive.
  return {
    synced: rowsToWrite.length,
    productsWithImages: rowsToWrite.filter((row) => row.image_url).length,
    deactivated: 0,
    complete,
  };
}

/**
 * Envoie un produit en photo avec sa légende (titre, description, prix).
 * La fiche native (productMessage) n’est plus utilisée : ses ids ne viennent pas
 * du catalogue WhatsApp, qui peut alors l’ignorer sans erreur et laisser le
 * client sans réponse. Un produit sans photo part en texte.
 */
export async function sendProductPhoto(sock, jid, product, message = '') {
  const item = normalizeProduct(product) || product;
  if (!item?.id || !item?.title) throw new Error('Produit du catalogue incomplet : id et titre requis.');

  const intro = String(message || '').trim();
  const caption = [intro, productCaption(item)].filter(Boolean).join('\n').slice(0, 1024);
  if (!item.imageUrl) return sock.sendMessage(jid, { text: caption });

  return sock.sendMessage(jid, { image: { url: item.imageUrl }, caption });
}

/** Légende d’une fiche : titre, description et prix, bornée à 1000 caractères. */
function productCaption(product) {
  return [product.title, product.description, formatPrice(product)]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1000);
}

/**
 * Envoie le catalogue sous forme de photos avec légende. Les fiches natives
 * (productMessage) sont écartées : leurs ids ne viennent pas du catalogue
 * WhatsApp, qui peut alors ignorer la fiche sans renvoyer d’erreur. Le message
 * image, lui, s’affiche toujours ; un produit sans photo part en texte.
 * Renvoie un tableau `{ product, result, type }` pour la journalisation.
 */
export async function sendCatalogProductCards(
  sock,
  jid,
  products,
  businessJid = BUSINESS_JID,
  message = 'Voici notre catalogue.',
) {
  const items = (products || [])
    .map((product) => normalizeProduct(product) || product)
    .filter((product) => product?.id && product?.title)
    .slice(0, 5);

  const sent = [];
  for (const [index, product] of items.entries()) {
    const intro = index === 0 ? String(message || '') : '';

    if (!product.imageUrl) {
      const text = [intro, productCaption(product)].filter(Boolean).join('\n');
      sent.push({
        product,
        result: await sock.sendMessage(jid, { text }),
        type: 'conversation',
      });
      continue;
    }

    const caption = [intro, productCaption(product)].filter(Boolean).join('\n');
    sent.push({
      product,
      result: await sock.sendMessage(jid, {
        image: { url: product.imageUrl },
        caption,
      }),
      type: 'imageMessage',
    });
  }

  return sent;
}

export async function sendProductList(sock, jid, products, message = 'Voici les produits correspondants.') {
  const items = (products || []).map((product) => normalizeProduct(product) || product)
    .filter((product) => product?.id && product?.title)
    .slice(0, 10);

  if (!items.length) {
    return sock.sendMessage(jid, { text: message || 'Je ne trouve pas de produit correspondant dans le catalogue.' });
  }

  return sock.sendMessage(jid, {
    text: message,
    footer: 'Choisissez un produit pour ouvrir sa fiche.',
    buttonText: 'Voir les produits',
    sections: [{
      title: 'Catalogue',
      rows: items.map((product) => ({
        title: product.title.slice(0, 24),
        description:
          [product.description, formatPrice(product)]
            .filter(Boolean)
            .join(' — ')
            .slice(0, 72) || undefined,
        rowId: `product:${product.id}`,
      })),
    }],
  });

}

export async function sendCatalogLink(sock, jid, businessJid = BUSINESS_JID, productId = null, message = '') {
  const digits = normalizeJid(businessJid).split('@')[0];
  if (!digits) throw new Error('Impossible de construire le lien : numéro WhatsApp Business absent.');
  const link = productId
    ? `https://wa.me/p/${encodeURIComponent(productId)}/${digits}`
    : `https://wa.me/c/${digits}`;
  const cleanMessage = String(message || '').replaceAll(link, '').trim();
  const text = [cleanMessage, link].filter(Boolean).join('\n');
  return sock.sendMessage(jid, { text });
}

// `normalizeProduct`, `formatPrice` et `preserveExistingImages` sont exportés
// pour les tests unitaires.
export {
  normalizeJid,
  normalizeProduct,
  formatPrice,
  preserveExistingImages,
  productCaption,
};
