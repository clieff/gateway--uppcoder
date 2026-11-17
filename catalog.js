import 'dotenv/config';
import axios from 'axios';

const BUSINESS_JID = process.env.BUSINESS_JID;
const CATALOG_GRAPHQL_URL = 'https://graph.whatsapp.com/graphql/catalog';
const CATALOG_ACCESS_TOKEN = process.env.WHATSAPP_CATALOG_ACCESS_TOKEN
  || 'WA|787118555984857|7bb1544a3599aa180ac9a3f7688ba243';
const CATALOG_QUERY_ID = process.env.WHATSAPP_CATALOG_QUERY_ID || '30445081048424116';
const CATALOG_HTTP_TIMEOUT_MS = 8_000;

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

/**
 * Lit le catalogue public via la requête HTTPS utilisée par WhatsApp Web.
 * sock.getCatalog() utilise l'ancienne requête w:biz:catalog qui expire sur
 * Baileys 7 RC lorsque WhatsApp ne répond plus à cette requête IQ.
 */
export async function getCatalogProducts() {
  if (!BUSINESS_JID) throw new Error('BUSINESS_JID doit identifier le compte Business propriétaire du catalogue.');

  const response = await axios.post(
    CATALOG_GRAPHQL_URL,
    {
      access_token: CATALOG_ACCESS_TOKEN,
      doc_id: CATALOG_QUERY_ID,
      lang: 'en_US',
      variables: {
        request: {
          product_catalog: {
            jid: normalizeJid(BUSINESS_JID),
            allow_shop_source: 'ALLOWSHOPSOURCE_TRUE',
            width: '100',
            height: '100',
            limit: '50',
            after: null,
            catalog_session_id: null,
            direct_connection_encrypted_info: null,
            variant_info_fields: null,
            variant_thumbnail_height: null,
            variant_thumbnail_width: null,
          },
        },
      },
    },
    {
      timeout: CATALOG_HTTP_TIMEOUT_MS,
      headers: { 'content-type': 'application/json' },
    },
  );

  const catalog = response.data?.data?.xwa_product_catalog_get_product_catalog?.product_catalog;
  if (!catalog) {
    const graphQLError = response.data?.errors?.[0]?.message;
    throw new Error(graphQLError || 'Réponse du catalogue WhatsApp invalide ou vide.');
  }

  const products = Array.isArray(catalog) ? catalog : catalog.products || [];
  return products.map(normalizeProduct).filter(Boolean).slice(0, 50);
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
        description: product.description.slice(0, 72) || undefined,
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

export { normalizeJid };
