import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  api, RequestCollection, SavedRequest, SendResult, WerkbankHistoryEntry,
  WkKeyValue, WkHeader, WerkbankMethod, Environment,
} from '../api/client';

const METHODS: WerkbankMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function methodColor(m: string): string {
  switch (m) {
    case 'GET': return 'text-emerald-400';
    case 'POST': return 'text-amber-400';
    case 'PUT': return 'text-blue-400';
    case 'PATCH': return 'text-violet-400';
    case 'DELETE': return 'text-red-400';
    default: return 'text-gray-400';
  }
}

function emptyDraft(collectionId: string): SavedRequest {
  return {
    _id: '', projectId: '', collectionId, name: 'Neuer Request', order: 0,
    method: 'GET', url: '', queryParams: [], headers: [],
    auth: { type: 'none' }, body: { mode: 'none' }, timeoutMs: 30000, followRedirects: false,
    createdAt: '', updatedAt: '',
  };
}

// Nur die editierbaren Felder — verhindert 400 bei forbidNonWhitelisted-ValidationPipe
// (kein _id/projectId/collectionId/createdAt im Body).
function toPayload(d: SavedRequest): Partial<SavedRequest> {
  return {
    name: d.name, description: d.description, order: d.order, method: d.method,
    url: d.url, queryParams: d.queryParams, headers: d.headers, auth: d.auth,
    body: d.body, timeoutMs: d.timeoutMs, followRedirects: d.followRedirects,
  };
}

export default function HttpRequestsTab({ projectId }: { projectId: string }) {
  const [collections, setCollections] = useState<RequestCollection[]>([]);
  const [requests, setRequests] = useState<SavedRequest[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [draft, setDraft] = useState<SavedRequest | null>(null);
  const [envId, setEnvId] = useState('');
  const [editorTab, setEditorTab] = useState<'params' | 'headers' | 'auth' | 'body'>('params');
  const [respTab, setRespTab] = useState<'body' | 'headers'>('body');
  const [response, setResponse] = useState<SendResult | null>(null);
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<WerkbankHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showCurl, setShowCurl] = useState(false);
  const [curlText, setCurlText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [cols, reqs, envs] = await Promise.all([
      api.httpRequests.listCollections(projectId),
      api.httpRequests.listRequests(projectId),
      api.environments.list(projectId).catch(() => [] as Environment[]),
    ]);
    setCollections(cols);
    setRequests(reqs);
    setEnvironments(envs);
  }, [projectId]);

  useEffect(() => { reload(); }, [reload]);

  const selectedEnv = environments.find((e) => e._id === envId);
  const availableKeys = useMemo(
    () => (selectedEnv?.variables ?? []).map((v) => v.key),
    [selectedEnv],
  );

  const patch = (p: Partial<SavedRequest>) => setDraft((d) => (d ? { ...d, ...p } : d));

  async function addCollection() {
    const name = prompt('Name der Collection?');
    if (!name) return;
    await api.httpRequests.createCollection(projectId, { name });
    await reload();
  }

  async function addRequest(collectionId: string) {
    setError(null);
    try {
      const created = await api.httpRequests.createRequest(collectionId, toPayload(emptyDraft(collectionId)));
      await reload();
      setDraft(created);
      setResponse(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function selectRequest(id: string) {
    const full = await api.httpRequests.getRequest(id);
    setDraft(full);
    setResponse(null);
    setShowHistory(false);
  }

  async function saveDraft(): Promise<SavedRequest | null> {
    if (!draft) return null;
    setError(null);
    try {
      const saved = draft._id
        ? await api.httpRequests.updateRequest(draft._id, toPayload(draft))
        : await api.httpRequests.createRequest(draft.collectionId, toPayload(draft));
      const full = await api.httpRequests.getRequest(saved._id || draft._id);
      setDraft(full);
      await reload();
      return full;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  async function send() {
    if (!draft) return;
    setSending(true);
    setError(null);
    try {
      const saved = await saveDraft();
      if (!saved) return;
      const res = await api.httpRequests.send(saved._id, {
        environmentId: envId || undefined,
        method: draft.method, url: draft.url, queryParams: draft.queryParams,
        headers: draft.headers, auth: draft.auth, body: draft.body,
        timeoutMs: draft.timeoutMs, followRedirects: draft.followRedirects,
      });
      setResponse(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function deleteRequest(id: string) {
    if (!confirm('Request löschen?')) return;
    await api.httpRequests.deleteRequest(id);
    if (draft?._id === id) setDraft(null);
    await reload();
  }

  async function loadHistory() {
    if (!draft?._id) return;
    setHistory(await api.httpRequests.history(draft._id));
    setShowHistory(true);
  }

  async function importCurl() {
    if (!draft) { setError('Erst eine Collection wählen / Request anlegen.'); return; }
    try {
      const parsed = await api.httpRequests.parseCurl(curlText);
      patch({
        method: parsed.method, url: parsed.url, queryParams: parsed.queryParams,
        headers: parsed.headers, auth: parsed.auth, body: parsed.body,
        followRedirects: parsed.followRedirects,
      });
      setShowCurl(false);
      setCurlText('');
      if (parsed.warnings.length) setError('Import-Hinweise: ' + parsed.warnings.join('; '));
    } catch (e) {
      setError('curl-Import fehlgeschlagen: ' + (e as Error).message);
    }
  }

  async function streamDownload() {
    if (!draft?._id) return;
    setError(null);
    try {
      const { url } = await api.httpRequests.downloadTicket(draft._id, envId || undefined);
      // url enthält bereits /api + ticket. Content-Disposition:attachment erzwingt
      // den Download; kein `download`-Attribut, damit der Server-Dateiname greift.
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setError('Download fehlgeschlagen: ' + (e as Error).message);
    }
  }

  function blobDownload() {
    if (!response) return;
    const blob = new Blob([response.body], { type: response.contentType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (draft?.name || 'response').replace(/[^\w.-]+/g, '_') + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---- Sidebar: Collections → Requests ----
  const sidebar = (
    <div className="w-64 shrink-0 border-r border-gray-700 pr-3 space-y-4 overflow-y-auto">
      <button
        onClick={addCollection}
        className="w-full text-xs px-2 py-1.5 rounded border border-gray-600 text-gray-200 hover:bg-gray-800 hover:border-indigo-500"
      >
        + Neue Collection
      </button>
      {collections.map((col) => (
        <div key={col._id}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-400 truncate">{col.name}</span>
            <button
              onClick={() => addRequest(col._id)}
              title="Request hinzufügen"
              className="shrink-0 text-[11px] px-1.5 py-0.5 rounded border border-gray-600 text-gray-300 hover:bg-gray-800 hover:border-indigo-500 hover:text-indigo-300"
            >
              + Request
            </button>
          </div>
          <ul className="mt-1 space-y-0.5">
            {requests.filter((r) => r.collectionId === col._id).map((r) => (
              <li key={r._id}>
                <button
                  onClick={() => selectRequest(r._id)}
                  className={`w-full text-left px-2 py-1 rounded text-sm flex items-center gap-2 hover:bg-gray-800 ${draft?._id === r._id ? 'bg-gray-800' : ''}`}
                >
                  <span className={`font-mono text-[10px] ${methodColor(r.method)}`}>{r.method}</span>
                  <span className="truncate text-gray-200">{r.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex gap-4 min-h-[60vh]">
      {sidebar}

      <div className="flex-1 min-w-0">
        {error && <div className="mb-3 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">{error}</div>}
        {!draft ? (
          <p className="text-gray-500 text-sm">Wähle links einen Request oder lege einen neuen an.</p>
        ) : (
          <div className="space-y-3">
            {/* Kopfzeile: Name + Actions */}
            <div className="flex items-center gap-2">
              <input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                className="bg-transparent text-lg font-semibold text-gray-100 outline-none flex-1"
              />
              <button onClick={() => setShowCurl(true)} className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-300 hover:bg-gray-800">curl importieren</button>
              <button onClick={saveDraft} className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-300 hover:bg-gray-800">Speichern</button>
              {draft._id && <button onClick={streamDownload} title="Antwort ohne Größenlimit auf die Platte streamen" className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-300 hover:bg-gray-800">Als Datei streamen</button>}
              {draft._id && <button onClick={loadHistory} className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-300 hover:bg-gray-800">History</button>}
              {draft._id && <button onClick={() => deleteRequest(draft._id)} className="text-xs px-2 py-1 rounded border border-red-800 text-red-400 hover:bg-red-900/30">Löschen</button>}
            </div>

            {/* URL-Leiste */}
            <div className="flex gap-2">
              <select value={draft.method} onChange={(e) => patch({ method: e.target.value as WerkbankMethod })}
                className={`bg-gray-800 border border-gray-700 rounded px-2 py-2 font-mono text-sm ${methodColor(draft.method)}`}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input value={draft.url} onChange={(e) => patch({ url: e.target.value })}
                placeholder="https://api.example.com/{{path}}"
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-100" />
              <select value={envId} onChange={(e) => setEnvId(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-2 text-sm text-gray-200">
                <option value="">(kein Environment)</option>
                {environments.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}
              </select>
              <button onClick={send} disabled={sending}
                className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium">
                {sending ? '…' : 'Senden'}
              </button>
            </div>
            <p className="text-[11px] text-gray-500">
              Löst Projekt-Secrets & Environment-Variablen serverseitig auf.
              {availableKeys.length > 0 && <> Verfügbar: {availableKeys.map((k) => <code key={k} className="mx-1 text-gray-400">{'{{'}{k}{'}}'}</code>)}</>}
            </p>

            {/* Editor-Untertabs */}
            <div className="border border-gray-700 rounded">
              <div className="flex gap-1 border-b border-gray-700 px-2 py-1">
                {(['params', 'headers', 'auth', 'body'] as const).map((t) => (
                  <button key={t} onClick={() => setEditorTab(t)}
                    className={`text-xs px-2 py-1 rounded ${editorTab === t ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
                    {t === 'params' ? 'Params' : t === 'headers' ? 'Headers' : t === 'auth' ? 'Auth' : 'Body'}
                  </button>
                ))}
              </div>
              <div className="p-3">
                {editorTab === 'params' && (
                  <KvEditor rows={draft.queryParams} onChange={(rows) => patch({ queryParams: rows })} keyLabel="Key" />
                )}
                {editorTab === 'headers' && (
                  <HeaderEditor rows={draft.headers} onChange={(rows) => patch({ headers: rows })} />
                )}
                {editorTab === 'auth' && (
                  <AuthEditor value={draft.auth} onChange={(auth) => patch({ auth })} />
                )}
                {editorTab === 'body' && (
                  <BodyEditor value={draft.body} onChange={(body) => patch({ body })} />
                )}
              </div>
            </div>

            {/* Response */}
            {response && (
              <div className="border border-gray-700 rounded">
                <div className="flex items-center gap-3 border-b border-gray-700 px-3 py-2 text-sm">
                  <span className={response.ok ? 'text-emerald-400' : 'text-red-400'}>
                    {response.error ? 'Fehler' : `${response.status} ${response.statusText ?? ''}`}
                  </span>
                  <span className="text-gray-500">{response.durationMs} ms</span>
                  <span className="text-gray-500">{response.bodySize} B{response.truncated ? ' (gekürzt)' : ''}</span>
                  {response.unresolvedVariables.length > 0 && (
                    <span className="text-amber-400">⚠ unaufgelöst: {response.unresolvedVariables.join(', ')}</span>
                  )}
                  <button onClick={blobDownload} className="ml-auto text-xs px-2 py-0.5 rounded border border-gray-600 text-gray-300 hover:bg-gray-800">Herunterladen</button>
                </div>
                <div className="flex gap-1 px-2 py-1 border-b border-gray-700">
                  {(['body', 'headers'] as const).map((t) => (
                    <button key={t} onClick={() => setRespTab(t)}
                      className={`text-xs px-2 py-1 rounded ${respTab === t ? 'bg-gray-700 text-gray-100' : 'text-gray-400'}`}>
                      {t === 'body' ? 'Body' : 'Headers'}
                    </button>
                  ))}
                </div>
                <pre className="p-3 text-xs text-gray-200 overflow-auto max-h-96 whitespace-pre-wrap break-words">
                  {response.error
                    ? response.error
                    : respTab === 'body'
                      ? prettyMaybeJson(response.body)
                      : response.responseHeaders.map((h) => `${h.name}: ${h.value}`).join('\n')}
                </pre>
              </div>
            )}

            {/* History */}
            {showHistory && (
              <div className="border border-gray-700 rounded p-3">
                <div className="flex justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-300">History (Secrets maskiert)</span>
                  <button onClick={() => setShowHistory(false)} className="text-xs text-gray-500">schließen</button>
                </div>
                <ul className="space-y-1 text-xs">
                  {history.map((h) => (
                    <li key={h._id} className="flex gap-3 text-gray-400">
                      <span className={h.ok ? 'text-emerald-400' : 'text-red-400'}>{h.error ? 'ERR' : h.status}</span>
                      <span className="font-mono">{h.method}</span>
                      <span className="truncate flex-1">{h.url}</span>
                      <span>{new Date(h.sentAt).toLocaleString()}</span>
                      <span>{h.durationMs} ms</span>
                    </li>
                  ))}
                  {history.length === 0 && <li className="text-gray-500">Noch keine Aufrufe.</li>}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* curl-Import-Modal */}
      {showCurl && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCurl(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 w-[600px] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-200 mb-2">curl importieren</h3>
            <textarea value={curlText} onChange={(e) => setCurlText(e.target.value)} rows={8}
              placeholder="curl -X POST https://… -H '…' -d '…'"
              className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs font-mono text-gray-100" />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setShowCurl(false)} className="text-xs px-3 py-1 rounded border border-gray-600 text-gray-300">Abbrechen</button>
              <button onClick={importCurl} className="text-xs px-3 py-1 rounded bg-indigo-600 text-white">In Editor übernehmen</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- kleine Editor-Bausteine ----------

function prettyMaybeJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function KvEditor({ rows, onChange, keyLabel }: { rows: WkKeyValue[]; onChange: (r: WkKeyValue[]) => void; keyLabel: string }) {
  const set = (i: number, p: Partial<WkKeyValue>) => onChange(rows.map((r, idx) => idx === i ? { ...r, ...p } : r));
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input type="checkbox" checked={r.enabled !== false} onChange={(e) => set(i, { enabled: e.target.checked })} />
          <input value={r.key} onChange={(e) => set(i, { key: e.target.value })} placeholder={keyLabel}
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs" />
          <input value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="Value"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
          <button onClick={() => onChange(rows.filter((_, idx) => idx !== i))} className="text-red-400 text-xs">✕</button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { key: '', value: '', enabled: true }])} className="text-xs text-indigo-400">+ Zeile</button>
    </div>
  );
}

function HeaderEditor({ rows, onChange }: { rows: WkHeader[]; onChange: (r: WkHeader[]) => void }) {
  const set = (i: number, p: Partial<WkHeader>) => onChange(rows.map((r, idx) => idx === i ? { ...r, ...p } : r));
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input type="checkbox" checked={r.enabled !== false} onChange={(e) => set(i, { enabled: e.target.checked })} />
          <input value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Header"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs" />
          <input value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="Value (z.B. {{TOKEN}})"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
          <button onClick={() => onChange(rows.filter((_, idx) => idx !== i))} className="text-red-400 text-xs">✕</button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { name: '', value: '', enabled: true }])} className="text-xs text-indigo-400">+ Header</button>
    </div>
  );
}

function AuthEditor({ value, onChange }: { value: SavedRequest['auth']; onChange: (a: SavedRequest['auth']) => void }) {
  return (
    <div className="space-y-2 text-xs">
      <select value={value.type} onChange={(e) => onChange({ ...value, type: e.target.value as SavedRequest['auth']['type'] })}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-1">
        <option value="none">Keine</option>
        <option value="basic">Basic</option>
        <option value="bearer">Bearer</option>
      </select>
      {value.type === 'basic' && (
        <div className="flex gap-2">
          <input value={value.username ?? ''} onChange={(e) => onChange({ ...value, username: e.target.value })} placeholder="Username"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1" />
          <input value={value.password ?? ''} onChange={(e) => onChange({ ...value, password: e.target.value })} placeholder="Password / {{SECRET}}"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono" />
        </div>
      )}
      {value.type === 'bearer' && (
        <input value={value.token ?? ''} onChange={(e) => onChange({ ...value, token: e.target.value })} placeholder="Token / {{SECRET}}"
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono" />
      )}
    </div>
  );
}

function BodyEditor({ value, onChange }: { value: SavedRequest['body']; onChange: (b: SavedRequest['body']) => void }) {
  return (
    <div className="space-y-2 text-xs">
      <select value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as SavedRequest['body']['mode'] })}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-1">
        <option value="none">Kein Body</option>
        <option value="raw">Raw</option>
        <option value="form-urlencoded">form-urlencoded</option>
        <option value="multipart">multipart</option>
      </select>
      {value.mode === 'raw' && (
        <>
          <input value={value.contentType ?? ''} onChange={(e) => onChange({ ...value, contentType: e.target.value })}
            placeholder="Content-Type (z.B. application/json)"
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1" />
          <textarea value={value.raw ?? ''} onChange={(e) => onChange({ ...value, raw: e.target.value })} rows={8}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono" />
        </>
      )}
      {(value.mode === 'form-urlencoded' || value.mode === 'multipart') && (
        <KvEditor rows={value.formFields ?? []} onChange={(formFields) => onChange({ ...value, formFields })} keyLabel="Field" />
      )}
    </div>
  );
}
