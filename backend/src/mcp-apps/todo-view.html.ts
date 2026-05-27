/**
 * HTML body for the `ui://devgrimoire/todo` UI-Resource. Pure HTML5 with
 * inline CSS + a small inline JSON-RPC-over-postMessage bridge — no external
 * fetches, no third-party scripts. Honours the spec's default-restrictive CSP
 * (`default-src 'none'; script-src 'self' 'unsafe-inline'; ...`).
 *
 * Lifecycle (per SEP-1865):
 *  1. Send `ui/initialize` request to parent and wait for hostContext
 *  2. Listen for `ui/notifications/tool-result` — the JSON Todo
 *  3. Render. Status quick-action buttons send `tools/call` with
 *     `name: "todo_update"` via JSON-RPC and re-render on the result.
 */
export const TODO_VIEW_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DevGrimoire Todo</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-primary, #0b0b10);
    --fg: var(--color-text-primary, #f3f3f4);
    --muted: var(--color-text-secondary, #9aa1a8);
    --accent: #8b5cf6;
    --accent-fg: #fff;
    --border: var(--color-border-primary, #2a2a33);
    --radius: var(--border-radius-md, 8px);
    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    background: var(--bg);
    color: var(--fg);
    font-size: 14px;
    line-height: 1.45;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .number { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--muted); }
  .badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid;
    background: rgba(139,92,246,0.12);
    color: var(--accent);
    border-color: rgba(139,92,246,0.35);
  }
  .badge[data-status="done"] { background: rgba(34,197,94,0.12); color: #22c55e; border-color: rgba(34,197,94,0.35); }
  .badge[data-status="review"] { background: rgba(245,158,11,0.12); color: #f59e0b; border-color: rgba(245,158,11,0.35); }
  .badge[data-status="in_progress"] { background: rgba(56,189,248,0.12); color: #38bdf8; border-color: rgba(56,189,248,0.35); }
  h1 { font-size: 16px; margin: 0; flex: 1 1 100%; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 6px; display: flex; gap: 12px; flex-wrap: wrap; }
  .description {
    margin-top: 10px;
    color: var(--fg);
    white-space: pre-wrap;
    word-wrap: break-word;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .actions { margin-top: 12px; display: flex; gap: 6px; flex-wrap: wrap; }
  button {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: transparent;
    color: var(--fg);
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button[aria-pressed="true"] {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
  }
  .empty { color: var(--muted); font-style: italic; }
  .error { color: #ef4444; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
  <div id="root" class="empty">Waiting for todo data…</div>
<script>
(function () {
  'use strict';
  let nextId = 1;
  const pending = new Map();
  let todo = null;
  let hostContext = null;
  let toolName = null;

  function send(message) {
    window.parent.postMessage(message, '*');
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      send({ jsonrpc: '2.0', id: id, method: method, params: params });
    });
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method: method, params: params });
  }

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.id != null && pending.has(data.id)) {
      const entry = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error.message || 'RPC error'));
      else entry.resolve(data.result);
      return;
    }
    if (data.method === 'ui/notifications/tool-result' && data.params) {
      // Spec: params carries the tool-result payload (structured content + text)
      onToolResult(data.params);
    } else if (data.method === 'ui/notifications/tool-input' && data.params) {
      // We remember which tool spawned us so action buttons know the entity.
      if (data.params.tool && data.params.tool.name) toolName = data.params.tool.name;
    } else if (data.method === 'ui/notifications/host-context-changed' && data.params) {
      hostContext = Object.assign({}, hostContext, data.params);
    }
  });

  function onToolResult(params) {
    // Spec leaves the exact shape host-dependent; we accept either a
    // structuredContent JSON or a content[0].text JSON string.
    let payload = null;
    if (params.structuredContent) {
      payload = params.structuredContent;
    } else if (Array.isArray(params.content) && params.content[0] && params.content[0].text) {
      try { payload = JSON.parse(params.content[0].text); } catch (e) { payload = null; }
    }
    if (!payload) { renderEmpty('No todo payload in tool result.'); return; }
    todo = payload;
    render();
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key in attrs) {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else if (key.startsWith('data-')) node.setAttribute(key, attrs[key]);
        else node.setAttribute(key, attrs[key]);
      }
    }
    if (children) {
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function setStatus(next) {
    if (!todo || !toolName) return;
    const updateName = toolName === 'todo_get' ? 'todo_update' : 'todo_update';
    request('tools/call', { name: updateName, arguments: { id: todo._id, status: next } })
      .then(function (result) {
        // Tool result is wrapped — try to parse the returned todo and re-render.
        const content = result && result.content && result.content[0];
        if (content && content.text) {
          try { todo = JSON.parse(content.text); render(); } catch (e) { /* leave UI as-is */ }
        }
      })
      .catch(function (err) {
        renderError(err.message || String(err));
      });
  }

  function render() {
    const root = document.getElementById('root');
    root.className = '';
    root.replaceChildren();
    if (!todo) { renderEmpty('No todo loaded.'); return; }
    const card = el('div', { class: 'card' });
    const header = el('div', { class: 'header' });
    if (todo.displayNumber) header.appendChild(el('span', { class: 'number', text: todo.displayNumber }));
    header.appendChild(el('span', { class: 'badge', 'data-status': todo.status || 'open', text: (todo.status || 'open').toUpperCase() }));
    if (todo.priority) header.appendChild(el('span', { class: 'badge', text: todo.priority.toUpperCase() }));
    header.appendChild(el('h1', { text: todo.title || '(untitled)' }));
    card.appendChild(header);

    const meta = el('div', { class: 'meta' });
    if (todo.tags && todo.tags.length) meta.appendChild(el('span', { text: '#' + todo.tags.join(' #') }));
    if (todo.repoLabel) meta.appendChild(el('span', { text: 'repo: ' + todo.repoLabel }));
    if (todo.milestoneId) meta.appendChild(el('span', { text: 'milestone: ' + todo.milestoneId }));
    card.appendChild(meta);

    if (todo.description) {
      card.appendChild(el('div', { class: 'description', text: todo.description }));
    }

    const actions = el('div', { class: 'actions' });
    const statuses = ['open', 'in_progress', 'review', 'done'];
    for (let i = 0; i < statuses.length; i++) {
      const s = statuses[i];
      const btn = el('button', { 'aria-pressed': todo.status === s ? 'true' : 'false', text: s.replace('_', ' ') });
      if (todo.status === s) btn.disabled = true;
      btn.addEventListener('click', function () { setStatus(s); });
      actions.appendChild(btn);
    }
    card.appendChild(actions);

    root.appendChild(card);
  }

  function renderEmpty(msg) {
    const root = document.getElementById('root');
    root.className = 'empty';
    root.textContent = msg || 'Waiting for todo data…';
  }

  function renderError(msg) {
    const root = document.getElementById('root');
    const err = el('div', { class: 'error', text: 'Update failed: ' + msg });
    root.appendChild(err);
  }

  // Kick off the MCP-Apps handshake. We declare inline-only display mode
  // and rely on the host's hostContext for theme + dimensions.
  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appCapabilities: { availableDisplayModes: ['inline'] },
    clientInfo: { name: 'devgrimoire-todo-view', version: '1.0.0' },
  }).then(function (result) {
    hostContext = (result && result.hostContext) || null;
    notify('ui/notifications/initialized', {});
  }).catch(function () {
    // No host = standalone preview (also possible when developing). Stay
    // in "waiting" state until tool-result lands via direct postMessage.
  });
})();
</script>
</body>
</html>`;
