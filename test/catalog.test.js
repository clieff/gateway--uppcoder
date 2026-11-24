import test from "node:test";
import assert from "node:assert/strict";

// db.js valide la présence des variables au chargement : on les renseigne
// avant d’importer catalog.js, sans jamais contacter Supabase.
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.BUSINESS_JID ||= "237600000000@s.whatsapp.net";

const { normalizeProduct, formatPrice, preserveExistingImages, sendCatalogProductCards, sendProductPhoto } =
  await import("../catalog.js");

function plainSpace(value) {
  return value.replace(/[\s\u00a0\u202f]+/g, " ");
}

test("normalizeProduct rejette un produit sans identifiant ou sans titre", () => {
  assert.equal(normalizeProduct({ title: "Sac" }), null);
  assert.equal(normalizeProduct({ id: "123" }), null);
});

test("normalizeProduct rejette les produits masqués", () => {
  assert.equal(normalizeProduct({ id: "1", title: "Sac", isHidden: true }), null);
  assert.equal(
    normalizeProduct({ id: "1", title: "Sac", isHidden: "ishidden_true" }),
    null,
  );
});

test("normalizeProduct convertit un prix texte et conserve la devise", () => {
  const product = normalizeProduct({
    id: "1",
    title: "Sac en cuir",
    price: "25000",
    currencyCode: "XAF",
    retailerId: "SAC-001",
  });

  assert.equal(product.price, 25000);
  assert.equal(product.currency, "XAF");
  assert.equal(product.retailerId, "SAC-001");
});

test("normalizeProduct remplace un prix non numérique par null", () => {
  const product = normalizeProduct({ id: "1", title: "Sac", price: "n/a" });
  assert.equal(product.price, null);
});

test("normalizeProduct choisit la meilleure image disponible", () => {
  const fromImages = normalizeProduct({
    id: "1",
    title: "Sac",
    media: { images: [{ request_image_url: "thumb.jpg", original_image_url: "full.jpg" }] },
  });
  assert.equal(fromImages.imageUrl, "full.jpg");

  const fromStringList = normalizeProduct({
    id: "2",
    title: "Sac",
    imageUrls: ["one.jpg", "two.jpg"],
  });
  assert.equal(fromStringList.imageUrl, "one.jpg");

  const fromFallback = normalizeProduct({
    id: "3",
    title: "Sac",
    imageUrl: "direct.jpg",
  });
  assert.equal(fromFallback.imageUrl, "direct.jpg");
});

test("formatPrice formate le prix en unité majeure avec sa devise", () => {
  assert.equal(plainSpace(formatPrice({ price: 25000, currency: "XAF" })), "25 000 XAF");
  assert.equal(formatPrice({ price: null, currency: "XAF" }), "");
  assert.equal(formatPrice({ price: "inconnu", currency: "XAF" }), "");
  assert.equal(formatPrice({ price: 12.5 }), "12,5");
});

test("preserveExistingImages garde l’image du bucket quand WhatsApp n’en fournit pas", () => {
  const rows = [
    { id: "ECL-001", image_url: null },
    { id: "g-1", image_url: null },
    { id: "natif-1", image_url: "https://cdn.example/wa.jpg" },
  ];
  const existing = [
    { id: "ECL-001", image_url: "https://bucket/images/image%201.jpeg" },
    { id: "natif-1", image_url: "https://bucket/images/natif.jpeg" },
    { id: "absent", image_url: "https://bucket/images/absent.jpeg" },
  ];

  const merged = preserveExistingImages(rows, existing);

  assert.equal(merged[0].image_url, "https://bucket/images/image%201.jpeg");
  assert.equal(merged[1].image_url, null);
  // L’image fournie par WhatsApp reste prioritaire.
  assert.equal(merged[2].image_url, "https://cdn.example/wa.jpg");
  assert.deepEqual(
    preserveExistingImages([{ id: "X", image_url: null }], undefined),
    [{ id: "X", image_url: null }],
  );
});

const BUSINESS_TEST_JID = "237600000000@s.whatsapp.net";
const CATALOG_ROWS = [
  { id: "ECL-001", title: "Lait de toilette Éclaircissant", description: "desc 1", price: 15000, currency: "FCFA", imageUrl: "https://bucket/1.jpeg" },
  { id: "g-1", title: "GAMME COMPLÈTE ECLAT HYDRATANTE", description: "", price: null, currency: "FCFA", imageUrl: "https://bucket/2.jpeg" },
  { id: "3", title: "LAIT HYDRATANT ET RÉPARATEUR", description: "desc 3", price: 5000, currency: "FCFA", imageUrl: "https://bucket/3.jpeg" },
];

function fakeSock(onSend = () => {}) {
  const sent = [];
  let attempts = 0;
  return {
    sent,
    async sendMessage(jid, content) {
      attempts += 1;
      onSend(attempts);
      sent.push({ jid, content });
      return { key: { id: `msg-${attempts}` } };
    },
  };
}

test("sendCatalogProductCards envoie une photo avec légende par produit", async () => {
  const sock = fakeSock();
  const results = await sendCatalogProductCards(
    sock,
    "237600000001@s.whatsapp.net",
    CATALOG_ROWS,
    BUSINESS_TEST_JID,
    "Voici notre catalogue.",
  );

  assert.equal(sock.sent.length, 3);
  assert.equal(results.length, 3);
  assert.deepEqual(
    sock.sent.map(({ content }) => content.image.url),
    ["https://bucket/1.jpeg", "https://bucket/2.jpeg", "https://bucket/3.jpeg"],
  );
  assert.deepEqual(
    results.map(({ type }) => type),
    ["imageMessage", "imageMessage", "imageMessage"],
  );
  // Aucune fiche native : WhatsApp ignore les productMessage aux ids inconnus.
  assert.equal(sock.sent[0].content.product, undefined);
  assert.match(sock.sent[0].content.caption, /^Voici notre catalogue\./);
  assert.match(plainSpace(sock.sent[0].content.caption), /15 000 FCFA/);
  assert.match(sock.sent[0].content.caption, /desc 1/);
  assert.doesNotMatch(sock.sent[1].content.caption, /Voici notre catalogue\./);
});

test("sendCatalogProductCards envoie un texte pour un produit sans photo", async () => {
  const sock = fakeSock();
  const results = await sendCatalogProductCards(
    sock,
    "237600000001@s.whatsapp.net",
    [CATALOG_ROWS[2], { id: "sans-image", title: "Sans photo", currency: "FCFA" }],
    BUSINESS_TEST_JID,
    "Voici notre catalogue.",
  );

  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[0].content.image.url, "https://bucket/3.jpeg");
  assert.match(sock.sent[0].content.caption, /LAIT HYDRATANT ET RÉPARATEUR/);
  assert.match(plainSpace(sock.sent[0].content.caption), /5 000 FCFA/);
  assert.match(sock.sent[1].content.text, /Sans photo/);
  assert.deepEqual(
    results.map(({ type }) => type),
    ["imageMessage", "conversation"],
  );
});

test("sendProductPhoto envoie la photo du produit choisi avec sa légende", async () => {
  const sock = fakeSock();
  await sendProductPhoto(
    sock,
    "237600000001@s.whatsapp.net",
    CATALOG_ROWS[2],
    "Parfait, voici le produit que vous avez choisi.",
  );

  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.image.url, "https://bucket/3.jpeg");
  assert.match(sock.sent[0].content.caption, /^Parfait, voici le produit que vous avez choisi./);
  assert.match(sock.sent[0].content.caption, /LAIT HYDRATANT ET RÉPARATEUR/);
  assert.match(plainSpace(sock.sent[0].content.caption), /5 000 FCFA/);
  // Jamais de fiche native : WhatsApp ignore ces ids et ne répondrait plus.
  assert.equal(sock.sent[0].content.product, undefined);
});

test("sendProductPhoto envoie un texte quand le produit n’a pas de photo", async () => {
  const sock = fakeSock();
  await sendProductPhoto(
    sock,
    "237600000001@s.whatsapp.net",
    { id: "sans-image", title: "Sans photo", price: 1000, currency: "FCFA" },
    "Voici le produit.",
  );

  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.image, undefined);
  assert.match(sock.sent[0].content.text, /^Voici le produit./);
  assert.match(sock.sent[0].content.text, /Sans photo/);
  assert.match(plainSpace(sock.sent[0].content.text), /1 000 FCFA/);
});
