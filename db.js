import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Définissez SUPABASE_URL et une clé Supabase serveur (recommandé : SUPABASE_SERVICE_ROLE_KEY).');
}

// Cette clé reste uniquement côté serveur. Ne jamais utiliser NEXT_PUBLIC_ avec une clé privilégiée.
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
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

export async function getChatHistory(jid, limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const { data, error } = await supabase
    .from('messages')
    .select('jid,wa_message_id,from_me,body,message_type,created_at')
    .eq('jid', jid)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) throw error;
  return (data || []).reverse();
}

export async function updateContact({ jid, pushName, lastInteraction }) {
  const { error } = await supabase.rpc('upsert_contact_from_gateway', {
    p_jid: jid,
    p_push_name: pushName || null,
    p_last_interaction: asIsoDate(lastInteraction || new Date()),
  });
  if (error) throw error;
}

export async function getContactByJid(jid) {
  const { data, error } = await supabase
    .from('contacts')
    .select('jid,push_name,last_interaction,followup_opt_in,last_followup_at,followup_message')
    .eq('jid', jid)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function markFollowupSent(jid, sentAt = new Date()) {
  const { error } = await supabase
    .from('contacts')
    .update({ last_followup_at: asIsoDate(sentAt) })
    .eq('jid', jid);

  if (error) throw error;
}
