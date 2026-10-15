'use strict';
// Kleiner OpenAI-kompatibler Fake-Server für research-e2e.sh.
// POST /v1/chat/completions (stream) -> Antwort nach Inhalt; GET /seite -> HTML.
const http = require('node:http');

const PORT = Number(process.env.PORT || 18080);
const HOST = process.env.HOST || '127.0.0.1';
const FAKE_WEB = process.env.FAKE_WEB || `127.0.0.1:${PORT}`;
const REPORT = '## Kurzfassung\nDer Fake-Lauf liefert einen festen Bericht mit Beleg [1]. '
  + 'Er dient nur dazu, dass der Endpunkt im Pool erreichbar ist und die Recherche starten kann.\n\n'
  + '## Offene Punkte\nKeine, dies ist ein Testbericht ohne echten Inhalt.\n';

function toolNames(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.map((t) => (t && t.function && t.function.name) || '');
}

function decide(body) {
  const names = toolNames(body);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = messages.some((m) => m && m.role === 'tool');
  if (names.includes('run_subtasks')) {
    if (hasToolResult) return { tool: 'write_report', args: { report: REPORT } };
    return { tool: 'run_subtasks', args: { subtasks: [{ question: 'Was ist ein E2E-Test?' }] } };
  }
  if (names.includes('read_page')) {
    if (!hasToolResult) return { tool: 'read_page', args: { url: `http://${FAKE_WEB}/seite` } };
    return { tool: 'submit_findings', args: { notes: 'Fakt [1]', findings: 'Fakt [1]' } };
  }
  return { text: '{"relevant":true,"notes":"Fakt [1]"}' };
}

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake' };

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/seite')) {
    const para = 'Ein End-to-End-Test prüft das Zusammenspiel aller Komponenten eines Systems. ';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>Testseite</title></head><body><article><h1>Testseite</h1><p>${para.repeat(12)}</p></article></body></html>`);
    return;
  }
  if (req.method === 'GET' && req.url.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake', object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* leer */ }
      const d = decide(body);
      if (body.stream !== true) {
        const message = d.tool
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: d.tool, arguments: JSON.stringify(d.args) } }] }
          : { role: 'assistant', content: d.text };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: d.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      if (d.tool) {
        sse(res, [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: d.tool, arguments: JSON.stringify(d.args) } }] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      } else {
        sse(res, [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: d.text }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]);
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, HOST, () => { console.log(`fake-llm listening on ${HOST}:${PORT}`); });
