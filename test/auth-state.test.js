import test from "node:test";
import assert from "node:assert/strict";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";

// Variables renseignées avant l’import de db.js, qui valide leur présence.
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.SUPABASE_BAILEYS_BUCKET ||= "baileys-auth";
process.env.SUPABASE_BAILEYS_INSTANCE_ID ||= "default";
// Le délai d’écriture différée est raccourci pour garder les tests rapides.
process.env.SUPABASE_BAILEYS_FLUSH_MS = "300";

const { supabase } = await import("../db.js");

const BUCKET = "baileys-auth";
const PREFIX = `sessions/${Buffer.from("default").toString("base64url")}`;

/** Faux Supabase Storage : suffisant pour exercer download/upload/list/remove. */
class FakeStorage {
  constructor() {
    this.buckets = new Map();
    this.objects = new Map();
    this.uploads = 0;
  }

  async getBucket(name) {
    const bucket = this.buckets.get(name);
    if (!bucket) {
      return {
        data: null,
        error: { statusCode: "404", error: "not_found", message: "Bucket not found" },
      };
    }
    return { data: bucket, error: null };
  }

  async createBucket(name, options = {}) {
    if (this.buckets.has(name)) return { data: null, error: { message: "already exists" } };
    this.buckets.set(name, { id: name, name, public: Boolean(options.public) });
    return { data: {}, error: null };
  }

  from(name) {
    const store = this;
    return {
      async download(path) {
        const content = store.objects.get(`${name}/${path}`);
        if (content == null) {
          return {
            data: null,
            error: { statusCode: "404", error: "not_found", message: "Object not found" },
          };
        }
        return { data: { text: async () => content }, error: null };
      },
      async upload(path, body, options = {}) {
        const key = `${name}/${path}`;
        if (store.objects.has(key) && !options.upsert) {
          return { data: null, error: { message: "already exists" } };
        }
        store.objects.set(key, Buffer.isBuffer(body) ? body.toString("utf8") : String(body));
        store.uploads += 1;
        return { data: { path }, error: null };
      },
      async list(prefix, options = {}) {
        const base = `${name}/${prefix}/`;
        const names = [...store.objects.keys()]
          .filter((key) => key.startsWith(base))
          .map((key) => key.slice(base.length))
          .filter((entry) => !entry.includes("/"))
          .sort();
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 100;
        return {
          data: names
            .slice(offset, offset + limit)
            .map((entry) => ({ name: entry, id: entry, metadata: {} })),
          error: null,
        };
      },
      // auth-state.js pagine la migration avec listV2, pas avec list.
      async listV2(options = {}) {
        const prefix = options.prefix ?? "";
        const base = `${name}/${prefix}`;
        const names = [...store.objects.keys()]
          .filter((key) => key.startsWith(base))
          .map((key) => key.slice(base.length))
          .filter((entry) => entry && !entry.includes("/"))
          .sort();
        const limit = options.limit ?? 100;
        const start = options.cursor ? names.indexOf(options.cursor) + 1 : 0;
        const page = names.slice(start, start + limit);
        const hasNext = start + limit < names.length;
        return {
          data: {
            objects: page.map((entry) => ({ name: entry, id: entry, metadata: {} })),
            hasNext,
            nextCursor: hasNext ? names[start + limit - 1] : undefined,
          },
          error: null,
        };
      },
      async remove(paths) {
        for (const path of paths) store.objects.delete(`${name}/${path}`);
        return { data: [], error: null };
      },
    };
  }

  has(path) {
    return this.objects.has(`${BUCKET}/${path}`);
  }

  read(path) {
    return this.objects.get(`${BUCKET}/${path}`);
  }

  write(path, content) {
    this.objects.set(`${BUCKET}/${path}`, content);
  }
}

function installFakeStorage() {
  const fake = new FakeStorage();
  Object.defineProperty(supabase, "storage", {
    value: fake,
    configurable: true,
    writable: true,
  });
  return fake;
}

let caseId = 0;
/** Instance neuve du module : simule un redémarrage du processus. */
async function freshAuthState() {
  caseId += 1;
  return import(`../auth-state.js?case=${caseId}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("première exécution : bucket privé créé, creds initialisées puis écrites au flush", async () => {
  const fake = installFakeStorage();
  const authState = await freshAuthState();
  const { state } = await authState.useSupabaseAuthState();

  assert.equal(fake.buckets.get(BUCKET).public, false, "le bucket doit être privé");
  assert.ok(state.creds.registrationId, "des creds doivent être initialisées");
  assert.equal(fake.has(`${PREFIX}/state.json`), false, "aucune écriture avant le flush");

  await authState.flushAuthState();

  const saved = JSON.parse(fake.read(`${PREFIX}/state.json`));
  assert.equal(saved.version, 2);
  assert.equal(saved.creds.registrationId, state.creds.registrationId);
});

test("get renvoie null pour une clé absente", async () => {
  installFakeStorage();
  const authState = await freshAuthState();
  const { state } = await authState.useSupabaseAuthState();

  assert.deepEqual(await state.keys.get("pre-key", ["1"]), { 1: null });
});

test("set / get : une clé écrite est relue, puis supprimée avec null", async () => {
  installFakeStorage();
  const authState = await freshAuthState();
  const { state } = await authState.useSupabaseAuthState();

  await state.keys.set({ "pre-key": { 1: { public: "p1" } } });
  assert.deepEqual(await state.keys.get("pre-key", ["1", "2"]), {
    1: { public: "p1" },
    2: null,
  });

  await state.keys.set({ "pre-key": { 1: null } });
  assert.deepEqual(await state.keys.get("pre-key", ["1"]), { 1: null });
});

test("l’écriture différée persiste sans flush explicite", async () => {
  const fake = installFakeStorage();
  const authState = await freshAuthState();
  const { state } = await authState.useSupabaseAuthState();

  await state.keys.set({ "pre-key": { 9: { public: "p9" } } });
  await wait(900); // délai configuré à 300 ms pour les tests

  const saved = JSON.parse(fake.read(`${PREFIX}/state.json`));
  assert.deepEqual(saved.keys["pre-key"], { 9: { public: "p9" } });
});

test("saveCreds écrit immédiatement : arrêt propre sans perte", async () => {
  const fake = installFakeStorage();
  const authState = await freshAuthState();
  const { state, saveCreds } = await authState.useSupabaseAuthState();

  state.creds.registrationId = 123456;
  await saveCreds();

  const saved = JSON.parse(fake.read(`${PREFIX}/state.json`));
  assert.equal(saved.creds.registrationId, 123456);
});

test("la session survit à un redémarrage du processus", async () => {
  installFakeStorage();
  const first = await freshAuthState();
  const { state } = await first.useSupabaseAuthState();

  await state.keys.set({ session: { abc: { token: "t" } } });
  await first.flushAuthState();

  const second = await freshAuthState();
  const { state: reloaded } = await second.useSupabaseAuthState();

  assert.equal(reloaded.creds.registrationId, state.creds.registrationId);
  assert.deepEqual(await reloaded.keys.get("session", ["abc"]), {
    abc: { token: "t" },
  });
});

test("migre l’ancien format (un objet par clé) puis supprime les anciens objets", async () => {
  const fake = installFakeStorage();
  fake.buckets.set(BUCKET, { id: BUCKET, name: BUCKET, public: false });

  const creds = initAuthCreds();
  const legacyCredsPath = `${PREFIX}/${Buffer.from("creds.json").toString("base64url")}.json`;
  fake.write(legacyCredsPath, JSON.stringify(creds, BufferJSON.replacer));

  const putLegacy = (file, value) => {
    const path = `${PREFIX}/${Buffer.from(file).toString("base64url")}.json`;
    fake.write(path, JSON.stringify(value, BufferJSON.replacer));
  };
  putLegacy("pre-key-7.json", { public: "p7" });
  putLegacy("session-abc.json", { token: "t" });

  const authState = await freshAuthState();
  const { state } = await authState.useSupabaseAuthState();

  assert.equal(state.creds.registrationId, creds.registrationId, "creds récupérées");
  assert.deepEqual(await state.keys.get("pre-key", ["7"]), { 7: { public: "p7" } });
  assert.deepEqual(await state.keys.get("session", ["abc"]), { abc: { token: "t" } });

  assert.equal(fake.has(legacyCredsPath), false, "ancien creds supprimé");
  assert.ok(fake.has(`${PREFIX}/state.json`), "nouvel état écrit avant le nettoyage");
  const saved = JSON.parse(fake.read(`${PREFIX}/state.json`));
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.keys["pre-key"], { 7: { public: "p7" } });
});

test("un objet inconnu annule la migration et conserve les anciens fichiers", async () => {
  const fake = installFakeStorage();
  fake.buckets.set(BUCKET, { id: BUCKET, name: BUCKET, public: false });

  const legacyCredsPath = `${PREFIX}/${Buffer.from("creds.json").toString("base64url")}.json`;
  const unknownPath = `${PREFIX}/${Buffer.from("objet-inconnu.json").toString("base64url")}.json`;
  fake.write(legacyCredsPath, JSON.stringify(initAuthCreds(), BufferJSON.replacer));
  fake.write(unknownPath, JSON.stringify({ x: 1 }));

  const authState = await freshAuthState();
  await assert.rejects(
    () => authState.useSupabaseAuthState(),
    /noms de clés historiques sont inconnus/,
  );

  assert.equal(fake.has(legacyCredsPath), true, "anciens fichiers conservés");
  assert.equal(fake.has(unknownPath), true, "objet inconnu conservé");
  assert.equal(fake.has(`${PREFIX}/state.json`), false, "aucun état partiel écrit");
});

test("un état déjà migré n’est pas réécrit au démarrage suivant", async () => {
  const fake = installFakeStorage();
  const first = await freshAuthState();
  const { state } = await first.useSupabaseAuthState();
  await state.keys.set({ "pre-key": { 2: { public: "p2" } } });
  await first.flushAuthState();
  const uploadsAfterFirst = fake.uploads;

  const second = await freshAuthState();
  await second.useSupabaseAuthState();

  assert.equal(fake.uploads, uploadsAfterFirst, "aucune écriture inutile au chargement");
});
