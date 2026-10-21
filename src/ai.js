// Verbindung zu Claude. Der API-Schlüssel kommt nur aus der Umgebungsvariable
// ANTHROPIC_API_KEY auf dem Server und landet nie im Browser.
import Anthropic from '@anthropic-ai/sdk';
import { UserError } from './logic.js';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
// Diese Modelle unterstützen den automatischen Ausweich-Mechanismus bei Ablehnungen.
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

let client = null;

export function aiAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Fragt Claude. Mit `schema` kommt garantiert gültiges JSON zurück (structured outputs).
 * `messages` ist entweder ein Text oder eine Liste von {role, content}.
 */
export async function askClaude({ system, messages, effort = 'low', schema = null, maxTokens = 16000 }) {
  if (!aiAvailable()) {
    throw new UserError('Der KI-Assistent ist noch nicht eingerichtet (der API-Schlüssel fehlt).', 503);
  }
  client ??= new Anthropic();
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages,
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
  };

  let msg;
  try {
    msg = SERVER_FALLBACK_MODELS.has(MODEL)
      ? await client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage()
      : await client.messages.stream(params).finalMessage();
  } catch (err) {
    console.error('Claude-Fehler:', err?.status, err?.message);
    if (err instanceof Anthropic.AuthenticationError) {
      throw new UserError('Der KI-Schlüssel ist ungültig. Bitte in den Hosting-Einstellungen prüfen.', 503);
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new UserError('Der Assistent ist gerade sehr beschäftigt. Bitte versuch es gleich noch einmal.', 503);
    }
    throw new UserError('Der Assistent ist gerade nicht erreichbar. Bitte später noch einmal versuchen.', 503);
  }

  if (msg.stop_reason === 'refusal') {
    throw new UserError('Darauf kann der Assistent leider nicht antworten.', 422);
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new UserError('Die Antwort war zu lang. Bitte die Frage kürzer stellen.', 422);
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError('Der Assistent hat unverständlich geantwortet. Bitte noch einmal versuchen.', 502);
  }
}

/** Chatverlauf aus dem Browser prüfen: nur Text, begrenzte Länge, abwechselnde Rollen. */
export function cleanHistory(history, question) {
  const q = typeof question === 'string' ? question.trim().slice(0, 600) : '';
  if (!q) throw new UserError('Bitte schreib eine Frage.');
  const out = [];
  for (const h of Array.isArray(history) ? history.slice(-10) : []) {
    if (!h || typeof h.text !== 'string' || !['user', 'assistant'].includes(h.role)) continue;
    const role = h.role;
    if (out.length === 0 && role !== 'user') continue;
    if (out.length && out[out.length - 1].role === role) continue;
    out.push({ role, content: h.text.slice(0, 1500) });
  }
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  out.push({ role: 'user', content: q });
  return out;
}
