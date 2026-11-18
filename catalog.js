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
const CATALOG_SYNC_TIMEOUT_MS = 30_000;

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
 * Baileys, puis l’enregistre dans public.products. Les produits absents du
 * catalogue WhatsApp sont désactivés (is_active = false) au lieu d’être
 * supprimés, et seulement si la pagination est allée au bout.
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
    return { synced: 0, deactivated: 0, complete };
  }

  const { error: upsertError } = await supabase
    .from('products')
    .upsert(rows, { onConflict: 'id' });
  if (upsertError) {
    throw new Error(`Enregistrement du catalogue dans Supabase impossible : ${upsertError.message}`);
  }

  let deactivated = 0;
  if (complete) {
    const ids = new Set(rows.map((row) => row.id));
    const { data: activeRows, error: readError } = await supabase
      .from('products')
      .select('id')
      .eq('is_active', true);
    if (readError) {
      throw new Error(`Lecture des produits actifs impossible : ${readError.message}`);
    }
    const stale = (activeRows || [])
      .map((row) => row.id)
      .filter((id) => !ids.has(id));
    if (stale.length) {
      const { error: deactivateError } = await supabase
        .from('products')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .in('id', stale);
      if (deactivateError) {
        throw new Error(`Désactivation des produits retirés impossible : ${deactivateError.message}`);
      }
      deactivated = stale.length;
    }
  }

  return { synced: rows.length, deactivated, complete };
}

export async function sendProductCard(sock, jid, product, businessJid = BUSINESS_JID, message = '') {
  const item = normalizeProduct(product) || product;
  if (!item?.id || !item?.title) throw new Error('Produit du catalogue incomplet : id et titre requis.');
  if (!item.imageUrl) {
    const digits = normalizeJid(businessJid).split('@')[0];
    const link = digits ? `https://wa.me/p/${encodeURIComponent(item.id)}/${digits}` : item.url;
    return sock.sendMessage(jid, { text: [message, link].filter(Boolean).join('\n') });
  }

  const content = {
    product: {
      productId: item.id,
      title: item.title,
      description: item.description || '',
      ...(item.currency ? { currencyCode: item.currency } : {}),
      ...(item.price == null ? {} : { priceAmount1000: Math.round(item.price * 1000) }),
      ...(item.retailerId ? { retailerId: item.retailerId } : {}),
      url: item.url || undefined,
      productImage: { url: item.imageUrl },
    },
    businessOwnerJid: normalizeJid(businessJid),
    body: message || undefined,
  };

  return sock.sendMessage(jid, content);
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
  const text = [message, link].filter(Boolean).join('\n');
  return sock.sendMessage(jid, { text });
}

// `normalizeProduct` et `formatPrice` sont exportés pour les tests unitaires.
export { normalizeJid, normalizeProduct, formatPrice };
