// Test-Ersatz für die Claude-Schnittstelle (nur für Tests und die lokale Vorschau).
// Antwortet im echten Streaming-Format der API, damit der Server-Code unverändert getestet wird.
// Start einzeln: node test/fake-claude.js 4999
import http from 'node:http';

export const requests = [];

function sse(res, text, stopReason = 'end_turn') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  // In mehreren Stücken senden, wie die echte API
  for (let i = 0; i < text.length; i += 40) {
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 40) } });
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

/** Spielt "Claude": liest die mitgeschickten Daten und antwortet passend. */
function answer(body) {
  const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
  const question = body.messages.at(-1).content;
  const q = typeof question === 'string' ? question : JSON.stringify(question);

  if (!body.output_config?.format) {
    // Mitarbeiter-Chat: freie Schichten aus den Daten zählen
    const free = system.split('\n').filter((l) => l.includes('FREI, kann eingetragen werden'));
    if (/frei/i.test(q)) {
      return free.length
        ? `Frei sind zum Beispiel: ${free.slice(0, 2).map((l) => l.trim().replace(/^- /, '').split(' – ')[0]).join(' und ')}.`
        : 'Gerade ist keine Schicht frei.';
    }
    return 'Dazu habe ich leider keine Informationen.';
  }

  // Admin-Chat: strukturierte Antwort
  const tomorrow = system.match(/(\d{4}-\d{2}-\d{2}) \(morgen\)/)?.[1];
  if (/unklar|wer ist/i.test(q)) {
    return JSON.stringify({ kind: 'rueckfrage', message: 'Meinst du Max Mustermann oder Max Moser?', actions: [] });
  }
  if (/kaputt/i.test(q)) {
    return JSON.stringify({ kind: 'vorschlag', message: 'Ich streiche das.', actions: [{ op: 'cancel_show', show_id: 999999, employee_id: null, film: null, date: null, time: null, note: null }] });
  }
  const m = /(\d{1,2})(?::(\d{2}))?\s*uhr/i.exec(q);
  if (/fällt.*aus|streich/i.test(q) && tomorrow && m) {
    const time = `${m[1].padStart(2, '0')}:${m[2] || '00'}`;
    const line = system.split('\n').find((l) => l.includes(`| ${tomorrow} (`) && l.includes(`| ${time} |`));
    if (line) {
      const id = Number(line.trim().split(' | ')[0]);
      return JSON.stringify({ kind: 'vorschlag', message: `Ich streiche morgen die Vorstellung um ${time} Uhr.`, actions: [{ op: 'cancel_show', show_id: id, employee_id: null, film: null, date: null, time: null, note: null }] });
    }
  }
  return JSON.stringify({ kind: 'antwort', message: 'Das habe ich nicht verstanden. Kannst du es anders sagen?', actions: [] });
}

export function startFakeClaude(port) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    requests.push({ url: req.url, headers: req.headers, body });
    // Das SDK schickt den Schlüssel als "Authorization: Bearer …" (ältere Versionen als x-api-key).
    const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (key !== 'test-schluessel') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    sse(res, answer(body));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1]?.endsWith('fake-claude.js')) {
  const port = Number(process.argv[2]) || 4999;
  await startFakeClaude(port);
  console.log(`Test-Claude läuft auf http://127.0.0.1:${port}`);
}
