import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, KubeCluster, KubeDescribeResult, KubeListRow } from '../../api/client';
import { errorMessage, isRecord } from '../../lib/narrow';
import { useKubeLogStream } from './hooks/useKubeLogStream';

interface Props {
  cluster: KubeCluster;
  kind: string;
  row: KubeListRow;
  onClose: () => void;
}

type Tab = 'overview' | 'yaml' | 'events' | 'logs';

/** Feste Klassen-Map — zusammengesetzte Tailwind-Klassen überleben den Purge nicht. */
const CONDITION_CLASSES: Record<'ok' | 'bad' | 'unknown', string> = {
  ok: 'text-emerald-300',
  bad: 'text-red-300',
  unknown: 'text-slate-300',
};

function conditionTone(status?: string): 'ok' | 'bad' | 'unknown' {
  if (status === 'True') return 'ok';
  if (status === 'False') return 'bad';
  return 'unknown';
}

/** Container-Namen aus dem beschriebenen Objekt — für die Auswahl im Logs-Reiter. */
function containersOf(object: unknown): string[] {
  if (!isRecord(object) || !isRecord(object.spec)) return [];
  const list = object.spec.containers;
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const c of list) {
    if (isRecord(c) && typeof c.name === 'string') names.push(c.name);
  }
  return names;
}

export function KubeResourceDrawer({ cluster, kind, row, onClose }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('overview');
  const [described, setDescribed] = useState<KubeDescribeResult | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [follow, setFollow] = useState(false);

  // Reset auf „neue Ressource", sobald sich Cluster/Kind/Zeile ändern —
  // während des Renderns, nicht im Effekt (gleiches Muster wie
  // `useKubeResources.ts`): React verwirft dann den halbfertigen Render und
  // committet direkt den zurückgesetzten Zustand, statt kurz die Daten der
  // vorigen Ressource anzuzeigen. `react-hooks/set-state-in-effect` verbietet
  // den synchronen `setState`-Aufruf, der dafür vorher im Effekt-Body stand.
  const resourceKey = `${cluster._id}::${kind}::${row.name}::${row.namespace ?? ''}`;
  const [loadedResourceKey, setLoadedResourceKey] = useState(resourceKey);
  if (resourceKey !== loadedResourceKey) {
    setLoadedResourceKey(resourceKey);
    setDescribed(null);
    setYaml(null);
    setError(null);
    // Auch die drei Ansichtszustände (Review-Fund A2). React verwendet bei
    // einem Wechsel auf eine ANDERE Zeile desselben Kinds dieselbe
    // Komponenteninstanz weiter — `container` blieb dann auf dem Namen aus
    // dem vorigen Pod stehen. Bei einem Pod mit mehreren Containern und
    // aktivem Logs-Reiter öffnete der Klick auf einen anderen Pod damit
    // einen Follow-Stream auf einen Container, den es dort nicht gibt: der
    // Cluster antwortet 400, und nur das Schliessen des Drawers half.
    // `tab` gehört dazu, weil der Logs-Reiter für ein Nicht-Pod-Kind gar
    // nicht existiert (`tabs` unten) und der Inhalt dann leer bliebe;
    // `follow` ebenso, damit eine neue Ressource nicht ungefragt streamt.
    setTab('overview');
    setContainer(undefined);
    setFollow(false);
  }

  // Beim Öffnen genau EINE Abfrage. YAML kommt erst, wenn der Reiter
  // gewählt wird — ein Klick auf eine Zeile soll nicht zwei Abfragen
  // gegen den Cluster auslösen.
  const describeRequestId = useRef(0);
  const loadDescribe = useCallback(async () => {
    const mine = ++describeRequestId.current;
    try {
      const d = await api.describeKubeResource(cluster._id, kind, row.name, row.namespace);
      if (mine !== describeRequestId.current) return;
      setDescribed(d);
    } catch (err) {
      if (mine !== describeRequestId.current) return;
      setError(errorMessage(err, t('kube.drawer.loadFailed')));
    }
  }, [cluster._id, kind, row.name, row.namespace, t]);

  useEffect(() => {
    void (async () => { await loadDescribe(); })();
  }, [loadDescribe]);

  const yamlRequestId = useRef(0);
  const loadYaml = useCallback(async () => {
    const mine = ++yamlRequestId.current;
    try {
      const r = await api.getKubeResourceYaml(cluster._id, kind, row.name, row.namespace);
      if (mine !== yamlRequestId.current) return;
      setYaml(r.yaml);
    } catch (err) {
      if (mine !== yamlRequestId.current) return;
      setError(errorMessage(err, t('kube.drawer.loadFailed')));
    }
  }, [cluster._id, kind, row.name, row.namespace, t]);

  useEffect(() => {
    if (tab !== 'yaml' || yaml !== null) return;
    void (async () => { await loadYaml(); })();
  }, [tab, yaml, loadYaml]);

  const containers = useMemo(() => containersOf(described?.object), [described]);

  const logs = useKubeLogStream({
    clusterId: cluster._id,
    namespace: row.namespace ?? '',
    pod: row.name,
    container: container ?? containers[0],
    follow,
    enabled: tab === 'logs' && kind === 'Pod' && Boolean(row.namespace),
  });

  // Auto-Scroll ans Ende, solange der Nutzer nicht selbst hochgescrollt hat.
  const logBox = useRef<HTMLPreElement | null>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = logBox.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [logs.lines]);

  // Der Logs-Reiter existiert nur für Pods — kein deaktivierter Reiter,
  // der Fragen aufwirft.
  const tabs: Tab[] = kind === 'Pod' && row.namespace
    ? ['overview', 'yaml', 'events', 'logs']
    : ['overview', 'yaml', 'events'];

  return (
    <div className="mt-4 rounded border border-slate-700 bg-slate-900/60">
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <span className="font-medium">{row.name}</span>
        {row.namespace && <span className="text-xs text-slate-400">{row.namespace}</span>}
        <button type="button" className="ml-auto rounded bg-slate-700 px-2 py-1 text-xs" onClick={onClose}>
          {t('kube.drawer.close')}
        </button>
      </div>

      <nav className="flex gap-1 border-b border-slate-800 px-3 pt-2">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            className={
              id === tab
                ? 'rounded-t bg-slate-800 px-3 py-1 text-sm'
                : 'rounded-t px-3 py-1 text-sm text-slate-400 hover:text-slate-200'
            }
            onClick={() => setTab(id)}
          >
            {t(`kube.drawer.tab.${id}`)}
          </button>
        ))}
      </nav>

      <div className="p-3">
        {error !== null && <p className="mb-2 text-sm text-red-300">{error}</p>}

        {tab === 'overview' && (
          described === null
            ? <p className="text-sm text-slate-400">{t('kube.view.loading')}</p>
            : described.conditions.length === 0
              ? <p className="text-sm text-slate-400">{t('kube.drawer.noConditions')}</p>
              : (
                <ul className="space-y-1 text-sm">
                  {described.conditions.map((c) => (
                    <li key={`${c.type ?? '?'}-${c.lastTransitionTime ?? ''}`}>
                      <span className={CONDITION_CLASSES[conditionTone(c.status)]}>
                        {c.type ?? '?'}: {c.status ?? '?'}
                      </span>
                      {c.reason && <span className="ml-2 text-slate-400">{c.reason}</span>}
                      {c.message && <span className="ml-2 text-slate-500">{c.message}</span>}
                    </li>
                  ))}
                </ul>
              )
        )}

        {tab === 'yaml' && (
          yaml === null
            ? <p className="text-sm text-slate-400">{t('kube.view.loading')}</p>
            : <pre className="max-h-96 overflow-auto rounded bg-slate-950 p-2 text-xs">{yaml}</pre>
        )}

        {tab === 'events' && (
          described === null
            ? <p className="text-sm text-slate-400">{t('kube.view.loading')}</p>
            : described.events.length === 0
              ? <p className="text-sm text-slate-400">{t('kube.drawer.noEvents')}</p>
              : (
                <ul className="space-y-1 text-sm">
                  {described.events.map((e, i) => (
                    <li key={`${e.reason ?? '?'}-${e.lastTimestamp ?? i}`}>
                      <span className={e.type === 'Warning' ? 'text-amber-300' : 'text-slate-300'}>
                        {e.reason ?? '?'}
                      </span>
                      {typeof e.count === 'number' && e.count > 1 && (
                        <span className="ml-1 text-xs text-slate-500">×{e.count}</span>
                      )}
                      {e.message && <span className="ml-2 text-slate-400">{e.message}</span>}
                    </li>
                  ))}
                </ul>
              )
        )}

        {tab === 'logs' && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              {containers.length > 1 && (
                <select
                  className="rounded border border-slate-700 bg-slate-900 p-1 text-xs"
                  value={container ?? containers[0]}
                  onChange={(e) => setContainer(e.target.value)}
                >
                  {containers.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              <label className="flex items-center gap-1 text-xs text-slate-300">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                {t('kube.drawer.follow')}
              </label>
              <button type="button" className="rounded bg-slate-700 px-2 py-1 text-xs" onClick={logs.clear}>
                {t('kube.drawer.clear')}
              </button>
              {logs.connected && <span className="text-xs text-emerald-300">{t('kube.drawer.streaming')}</span>}
              {/*
                Ein sauberes Ende (`type: 'done'`) und ein Abbruch
                (`type: 'error'`) sehen bewusst unterschiedlich aus: ein
                stiller Übergang von „Live" zu nichts würde abgeschnittene
                Logs wie ein vollständiges Ende aussehen lassen — genau
                während eines Vorfalls, wegen dem jemand die Logs
                aufgerufen hat.
              */}
              {!logs.connected && logs.error === null && logs.lines.length > 0 && (
                <span className="text-xs text-slate-500">{t('kube.drawer.streamEnded')}</span>
              )}
            </div>
            {logs.error !== null && (
              <div className="rounded border border-red-700 bg-red-900/40 px-2 py-1 text-xs text-red-200">
                {t('kube.drawer.streamError', { message: logs.error })}
              </div>
            )}
            <pre
              ref={logBox}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }}
              className="max-h-96 overflow-auto rounded bg-slate-950 p-2 text-xs"
            >
              {logs.lines.join('\n')}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
