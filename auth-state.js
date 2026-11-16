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
const objectLocks = new Map();
let bucketSetup;

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

async function setupBucket() {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bucketName)) {
    throw new Error("SUPABASE_BAILEYS_BUCKET contient un nom de bucket invalide.");
  }
  if (!instanceId) {
    throw new Error("SUPABASE_BAILEYS_INSTANCE_ID ne peut pas être vide.");
  }

  const storage = supabase.storage;
  const { data: existingBucket, error: lookupError } =
    await storage.getBucket(bucketName);

  if (!lookupError) {
    assertPrivateBucket(existingBucket);
    return;
  }
  if (!isNotFound(lookupError)) throw lookupError;

  const { error: createError } = await storage.createBucket(bucketName, {
    public: false,
  });

  // Vérifie la confidentialité, y compris si une autre instance a créé le bucket en même temps.
  const { data: createdBucket, error: verifyError } =
    await storage.getBucket(bucketName);
  if (verifyError) throw createError || verifyError;
  assertPrivateBucket(createdBucket);
}

async function ensureBucket() {
  if (!bucketSetup) {
    bucketSetup = setupBucket().catch((error) => {
      bucketSetup = null;
      throw error;
    });
  }
  return bucketSetup;
}

function getObjectPath(file) {
  const encodedFile = Buffer.from(file, "utf8").toString("base64url");
  return `${instancePrefix}/${encodedFile}.json`;
}

async function withObjectLock(path, operation) {
  const previous = objectLocks.get(path) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  objectLocks.set(path, current);

  try {
    return await current;
  } finally {
    if (objectLocks.get(path) === current) objectLocks.delete(path);
  }
}

async function readData(file) {
  await ensureBucket();
  const path = getObjectPath(file);

  return withObjectLock(path, async () => {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .download(path);

    if (error) {
      if (isNotFound(error)) return null;
      throw new Error(`Lecture de session Supabase Storage impossible: ${error.message}`);
    }
    if (!data) return null;

    return JSON.parse(await data.text(), BufferJSON.reviver);
  });
}

async function writeData(value, file) {
  await ensureBucket();
  const path = getObjectPath(file);
  const body = Buffer.from(JSON.stringify(value, BufferJSON.replacer), "utf8");

  return withObjectLock(path, async () => {
    const { error } = await supabase.storage.from(bucketName).upload(path, body, {
      contentType: "application/json",
      cacheControl: "0",
      upsert: true,
    });

    if (error) {
      throw new Error(`Écriture de session Supabase Storage impossible: ${error.message}`);
    }
  });
}

async function removeData(file) {
  await ensureBucket();
  const path = getObjectPath(file);

  return withObjectLock(path, async () => {
    const { error } = await supabase.storage.from(bucketName).remove([path]);
    if (error && !isNotFound(error)) {
      throw new Error(`Suppression de session Supabase Storage impossible: ${error.message}`);
    }
  });
}

export async function clearSupabaseAuthState() {
  await ensureBucket();
  const storage = supabase.storage.from(bucketName);
  const paths = [];
  const pageSize = 100;
  let offset = 0;

  while (true) {
    const { data, error } = await storage.list(instancePrefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;

    const page = data || [];
    paths.push(
      ...page
        .filter((item) => item.id || item.metadata)
        .map((item) => `${instancePrefix}/${item.name}`),
    );
    if (page.length < pageSize) break;
    offset += page.length;
  }

  for (let index = 0; index < paths.length; index += pageSize) {
    const { error } = await storage.remove(paths.slice(index, index + pageSize));
    if (error) throw error;
  }
}

export async function useSupabaseAuthState() {
  await ensureBucket();
  const storedCreds = await readData("creds.json");
  const creds = storedCreds || initAuthCreds();
  if (!storedCreds) await writeData(creds, "creds.json");

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const [category, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries || {})) {
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds.json"),
  };
}
