import 'dotenv/config';

const BUSINESS_JID = process.env.BUSINESS_JID;

function normalizeJid(jid) {
  if (!jid) return '';
  const value = String(jid).trim();
  if (value.includes('@')) return value.replace(/:\d+@/, '@');
  return `${value.replace(/\D/g, '')}@s.whatsapp.net`;
}

function getImageUrl(product) {
  const images = product?.imageUrls;
  if (typeof images === 'string') return images;
  if (Array.isArray(images)) return images[0]?.original || images[0]?.url || images[0];
  if (images && typeof images === 'object') return images.requested || images.original || images.url;
  return product?.imageUrl || product?.image || product?.thumbnailUrl || null;
}

function normalizeProduct(product) {
  const id = String(product?.id || product?.productId || '');
  const title = String(product?.name || product?.title || '');
  const price = product?.price == null || product.price === '' ? null : Number(product.price);

  if (!id || !title || product?.isHidden) return null;

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

/** Lit le catalogue natif du compte WhatsApp Business via l'API Baileys. */
export async function getCatalogProducts(sock) {
  if (!BUSINESS_JID) throw new Error('BUSINESS_JID doit identifier le compte Business propriétaire du catalogue.');
  if (typeof sock?.getCatalog !== 'function') {
    throw new Error('Cette version de Baileys ne fournit pas sock.getCatalog().');
  }

  const catalog = await sock.getCatalog({ jid: normalizeJid(BUSINESS_JID), limit: 50 });
  const products = Array.isArray(catalog) ? catalog : catalog?.products || catalog?.data || [];
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
