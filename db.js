import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_REQUEST_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const callerSignal =
    init.signal ||
    (typeof Request !== "undefined" && input instanceof Request
      ? input.signal
      : undefined);
  const abortFromCaller = () => controller.abort(callerSignal.reason);

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `Supabase request exceeded ${SUPABASE_REQUEST_TIMEOUT_MS} ms.`,
          "TimeoutError",
        ),
      ),
    SUPABASE_REQUEST_TIMEOUT_MS,
  );

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Définissez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY dans l’environnement du gateway.');
}

// Cette clé reste uniquement côté serveur. Ne jamais utiliser NEXT_PUBLIC_ avec une clé privilégiée.
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fetchWithTimeout },
});

function asIsoDate(value) {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Horodatage de message invalide.');
  return date.toISOString();
}

function toMessageRow(message) {
  return {
    jid: message.jid,
    wa_message_id: message.messageId,
    from_me: Boolean(message.fromMe),
    body: String(message.body || '').slice(0, 16000),
    message_type: message.messageType || 'unknown',
    created_at: asIsoDate(message.timestamp || new Date()),
  };
}

export async function saveMessages(messages) {
  if (!messages.length) return { inserted: 0 };

  const rows = messages.filter((message) => message.jid && message.messageId).map(toMessageRow);
  if (!rows.length) return { inserted: 0 };

  const { data, error } = await supabase
    .from('messages')
    .upsert(rows, { onConflict: 'jid,wa_message_id', ignoreDuplicates: true })
    .select('id');

  if (error) throw error;
  return { inserted: data?.length || 0 };
}

export async function saveMessage(message) {
  const result = await saveMessages([message]);
  return { inserted: result.inserted > 0 };
}

export async function updateContact({ jid, pushName, lastInteraction }) {
  const { error } = await supabase.rpc('upsert_contact_from_gateway', {
    p_jid: jid,
    p_push_name: pushName || null,
    p_last_interaction: asIsoDate(lastInteraction || new Date()),
  });
  if (error) throw error;
}

/**
 * Désinscription aux relances. La fonction SQL marque followup_opt_in = false,
 * ce qui sort immédiatement le contact du cron /api/relance.
 */
export async function setFollowupOptIn(jid, optIn) {
  const { error } = await supabase.rpc('set_followup_opt_in', {
    p_jid: jid,
    p_opt_in: Boolean(optIn),
  });
  if (error) throw error;
}
