import {
  BufferJSON,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";
import { supabase } from "./db.js";

const bucketName = String(
  process.env.SUPABASE_BAILEYS_BUCKET || "baileys-auth",
).trim();
const instanceId = String(
  process.env.SUPABASE_BAILEYS_INSTANCE_ID || "default",
).trim();
const instancePrefix = `sessions/${Buffer.from(instanceId).toString("base64url")}`;
/**
 * Toute la session (creds + clés Signal) est stockée dans un seul objet JSON.
 * L’ancien format écrivait un objet par clé, ce qui provoquait des centaines
 * d’aller-retours HTTP au démarrage ; il est migré une seule fois.
 */
const statePath = `${instancePrefix}/state.json`;
const LEGACY_READ_CONCURRENCY = 8;
const FLUSH_DELAY_MS = Math.max(
  200,
  Number(process.env.SUPABASE_BAILEYS_FLUSH_MS || 1500),
);
const KEY_TYPES = [
  "app-state-sync-key",
  "app-state-sync-version",
  "sender-key-memory",
  "sender-key",
  "pre-key",
  "session",
  "device-list",
  "tctoken",
  "label",
  "lid-mapping",
];

let bucketSetup;
let statePromise;
let memoryState;
let dirty = false;
let flushTimer;
let writeChain = Promise.resolve();

function isNotFound(error) {
  return (
    String(error?.statusCode || error?.status || "") === "404" ||
    ["NoSuchBucket", "NoSuchKey", "not_found", "NotFound"].includes(
      error?.error || error?.code,
    )
  );
}

function assertPrivateBucket(bucket) {
  if (bucket?.public) {
    throw new Error(
      `Le bucket Supabase « ${bucketName} » est public. Le stockage de session Baileys exige un bucket privé.`,
    );
  }
}

async function setupBucket(onProgress) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bucketName)) {
    throw new Error("SUPABASE_BAILEYS_BUCKET contient un nom de bucket invalide.");
  }
  if (!instanceId) {
    throw new Error("SUPABASE_BAILEYS_INSTANCE_ID ne peut pas être vide.");
  }

  onProgress?.({ phase: "checking_storage_bucket" });
  const storage = supabase.storage;
  const { data: existingBucket, error: lookupError } =
    await storage.getBucket(bucketName);

  if (!lookupError) {
    assertPrivateBucket(existingBucket);
    onProgress?.({ phase: "storage_bucket_ready" });
    return;
  }
  if (!isNotFound(lookupError)) throw lookupError;

  onProgress?.({ phase: "creating_storage_bucket" });
  const { error: createError } = await storage.createBucket(bucketName, {
    public: false,
  });

  // Vérifie la confidentialité, y compris si une autre instance a créé le bucket en même temps.
  const { data: createdBucket, error: verifyError } =
    await storage.getBucket(bucketName);
  if (verifyError) throw createError || verifyError;
  assertPrivateBucket(createdBucket);
  onProgress?.({ phase: "storage_bucket_ready" });
}

async function ensureBucket(onProgress) {
  if (!bucketSetup) {
    bucketSetup = setupBucket(onProgress).catch((error) => {
      bucketSetup = null;
      throw error;
    });
  }
  return bucketSetup;
}

async function downloadJson(path) {
  await ensureBucket();
  const { data, error } = await supabase.storage
    .from(bucketName)
    .download(path);

  if (error) {
    if (isNotFound(error)) return null;
    throw new Error(`Lecture de session Supabase Storage impossible: ${error.message}`);
  }
  if (!data) return null;

  try {
    return JSON.parse(await data.text(), BufferJSON.reviver);
  } catch {
    return null;
  }
}

async function listObjects(prefix, onProgress) {
  const storage = supabase.storage.from(bucketName);
  const pageSize = 1_000;
  const names = [];
  let cursor;
  let pageNumber = 0;

  while (true) {
    const { data, error } = await storage.listV2({
      prefix: `${prefix}/`,
      limit: pageSize,
      cursor,
      with_delimiter: false,
    });
    if (error) throw error;

    const objects = data?.objects || [];
    names.push(...objects.map((item) => item.name));
    pageNumber += 1;
    onProgress?.({
      phase: "listing_legacy_session_files",
      page: pageNumber,
      listed: names.length,
      hasNext: Boolean(data?.hasNext),
    });

    if (!data?.hasNext) break;
    if (!data.nextCursor) {
      throw new Error("Supabase Storage indique une page suivante sans curseur.");
    }
    cursor = data.nextCursor;
  }

  return names;
}

function serialize(state) {
  const keys = {};
  for (const [type, entries] of state.keys) {
    keys[type] = Object.fromEntries(entries);
  }
  return Buffer.from(
    JSON.stringify({ version: 2, creds: state.creds, keys }, BufferJSON.replacer),
    "utf8",
  );
}

function hydrate(parsed) {
  const keys = new Map();
  for (const [type, entries] of Object.entries(parsed?.keys || {})) {
    const map = new Map();
    for (const [id, value] of Object.entries(entries || {})) {
      if (value != null) map.set(id, value);
    }
    if (map.size) keys.set(type, map);
  }
  return { creds: parsed?.creds || initAuthCreds(), keys };
}

function putKey(keys, type, id, value) {
  if (!keys.has(type)) keys.set(type, new Map());
  keys.get(type).set(id, value);
}

/** Décode un ancien objet « <base64url(type-id.json)>.json ». */
function parseLegacyKeyName(objectName) {
  if (!objectName.endsWith(".json")) return null;
  let decoded;
  try {
    decoded = Buffer.from(
      objectName.slice(0, -".json".length),
      "base64url",
    ).toString("utf8");
  } catch {
    return null;
  }
  if (!decoded.endsWith(".json") || decoded === "creds.json") return null;

  const base = decoded.slice(0, -".json".length);
  const type = KEY_TYPES.find((candidate) => base.startsWith(`${candidate}-`));
  if (!type) return null;
  const id = base.slice(type.length + 1);
  return id ? { type, id } : null;
}

/**
 * Migration unique depuis l’ancien format (un objet par clé). Sans elle, les
 * déploiements existants perdraient leur session et devraient ré-appairer.
 */
async function migrateLegacyState(onProgress) {
  onProgress?.({ phase: "listing_legacy_session_files" });
  const names = await listObjects(instancePrefix, onProgress);
  const legacyNames = names.filter((name) => name !== "state.json");
  onProgress?.({ phase: "legacy_session_files_listed", total: legacyNames.length });
  if (!legacyNames.length) return null;

  onProgress?.({ phase: "reading_legacy_credentials" });
  const creds = await downloadJson(
    `${instancePrefix}/${Buffer.from("creds.json", "utf8").toString("base64url")}.json`,
  );
  if (!creds) return null;

  const keys = new Map();
  let completed = 0;
  let restored = 0;
  for (let offset = 0; offset < legacyNames.length; offset += LEGACY_READ_CONCURRENCY) {
    const batch = legacyNames.slice(offset, offset + LEGACY_READ_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (name) => {
        const parsed = parseLegacyKeyName(name);
        if (!parsed) return null;
        const value = await downloadJson(`${instancePrefix}/${name}`);
        return value == null ? null : { ...parsed, value };
      }),
    );
    for (const result of results) {
      if (!result) continue;
      putKey(keys, result.type, result.id, result.value);
      restored += 1;
    }
    completed += batch.length;
    onProgress?.({
      phase: "reading_legacy_session_keys",
      completed,
      total: legacyNames.length,
      restored,
    });
  }

  const migrated = { creds, keys };
  // Le nouvel état est écrit AVANT la suppression des anciens objets : une
  // coupure entre les deux laisse toujours une session récupérable.
  onProgress?.({ phase: "writing_migrated_session", restored });
  await uploadState(serialize(migrated));
  onProgress?.({ phase: "migrated_session_written", restored });

  // Les anciens objets ne sont plus lus : on les retire pour éviter deux sources de vérité.
  try {
    const storage = supabase.storage.from(bucketName);
    for (let index = 0; index < legacyNames.length; index += 100) {
      await storage.remove(
        legacyNames.slice(index, index + 100).map((name) => `${instancePrefix}/${name}`),
      );
    }
  } catch {
    /* nettoyage best-effort : la session migrée reste valide */
  }

  return migrated;
}

async function loadState(onProgress) {
  await ensureBucket(onProgress);
  onProgress?.({ phase: "reading_current_session" });
  const stored = await downloadJson(statePath);
  if (stored) {
    onProgress?.({ phase: "current_session_loaded" });
    return hydrate(stored);
  }

  const migrated = await migrateLegacyState(onProgress);
  if (migrated) return migrated;

  onProgress?.({ phase: "creating_new_session" });
  return { creds: initAuthCreds(), keys: new Map() };
}

async function uploadState(payload = serialize(memoryState)) {
  await ensureBucket();
  const { error } = await supabase.storage.from(bucketName).upload(statePath, payload, {
    contentType: "application/json",
    cacheControl: "0",
    upsert: true,
  });
  if (error) {
    throw new Error(`Écriture de session Supabase Storage impossible: ${error.message}`);
  }
}

async function flushNow() {
  if (!memoryState || !dirty) return;
  dirty = false;
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => uploadState())
    .catch((error) => {
      // Une écriture perdue laisse l’état sale : le prochain flush réessaiera.
      dirty = true;
      throw error;
    });
  return writeChain;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushNow().catch((error) => {
      console.error("Session Baileys non enregistrée:", error?.message || error);
    });
  }, FLUSH_DELAY_MS);
}

/** Écrit immédiatement l’état en attente (arrêt du processus, déconnexion). */
export async function flushAuthState() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  await flushNow();
}

export async function clearSupabaseAuthState() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  dirty = false;
  statePromise = undefined;
  memoryState = undefined;

  await ensureBucket();
  const names = await listObjects(instancePrefix);
  const storage = supabase.storage.from(bucketName);
  const paths = names.map((name) => `${instancePrefix}/${name}`);

  for (let index = 0; index < paths.length; index += 100) {
    const { error } = await storage.remove(paths.slice(index, index + 100));
    if (error) throw error;
  }
}

export async function useSupabaseAuthState({ onProgress } = {}) {
  if (!statePromise) {
    statePromise = loadState(onProgress)
      .then((state) => {
        memoryState = state;
        // Première exécution : persiste tout de suite les creds initiaux.
        dirty = !state.keys.size;
        onProgress?.({ phase: "session_ready", keyTypes: state.keys.size });
        return state;
      })
      .catch((error) => {
        statePromise = undefined;
        throw error;
      });
  }

  memoryState = await statePromise;

  return {
    state: {
      creds: memoryState.creds,
      keys: {
        get: async (type, ids) => {
          const entries = memoryState.keys.get(type);
          const data = {};
          for (const id of ids) {
            let value = entries?.get(id) ?? null;
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const [type, values] of Object.entries(data || {})) {
            for (const [id, value] of Object.entries(values || {})) {
              if (value == null) {
                const entries = memoryState.keys.get(type);
                entries?.delete(id);
                if (entries && !entries.size) memoryState.keys.delete(type);
              } else {
                putKey(memoryState.keys, type, id, value);
              }
            }
          }
          dirty = true;
          scheduleFlush();
        },
      },
    },
    saveCreds: async () => {
      dirty = true;
      await flushNow();
    },
  };
}
