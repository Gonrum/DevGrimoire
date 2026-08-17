import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  Harness,
  HarnessMergeStrategy,
  HarnessScope,
  HarnessSection,
  ResolvedHarness,
  ResolvedSectionOrigin,
} from '../api/client';
import { errorMessage, isRecord, optionOr } from '../lib/narrow';
import Markdown from './Markdown';
import MarkdownEditor from './MarkdownEditor';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormSelect } from './ui/FormField';

/**
 * Harness-Editor mit aufgelöster Vorschau (T-444, M-51/H1).
 *
 * Zwei Ansichten, und die zweite ist Pflicht, nicht Kür: ein Merge über drei
 * Ebenen ist im Betrieb sonst nicht nachvollziehbar. „Warum steht in meinem
 * Projekt diese Regel?" muss die Oberfläche beantworten können — deshalb weist
 * die Vorschau pro Section jede beteiligte Ebene samt ihrer Merge-Strategie
 * aus und zeigt abgeschaltete Sections als abgeschaltet an, statt sie
 * verschwinden zu lassen.
 */

const MERGE_STRATEGIES: readonly HarnessMergeStrategy[] = ['replace', 'append', 'prepend'];
const EDITABLE_KINDS = ['prose', 'bootstrap'] as const;

/*
 * Feste Klassen-Zuordnung statt zusammengebauter Strings: Tailwind entfernt
 * beim Build jede Klasse, die nicht wörtlich im Quelltext steht — ein
 * `bg-${color}-900` wäre zur Laufzeit einfach unsichtbar (Review-Kriterium aus
 * CLAUDE.md).
 */
const SCOPE_BADGE: Record<HarnessScope, string> = {
  global: 'bg-purple-900/40 border-purple-700 text-purple-300',
  customer: 'bg-amber-900/40 border-amber-700 text-amber-300',
  project: 'bg-cyan-900/40 border-cyan-700 text-cyan-300',
};

const KIND_BADGE: Record<string, string> = {
  prose: 'bg-gray-800 border-gray-700 text-gray-300',
  bootstrap: 'bg-blue-900/40 border-blue-700 text-blue-300',
  block: 'bg-teal-900/40 border-teal-700 text-teal-300',
  constraint: 'bg-red-900/40 border-red-700 text-red-300',
};
const KIND_BADGE_FALLBACK = 'bg-gray-800 border-gray-700 text-gray-400';

export interface HarnessOwner {
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
}

interface Props {
  owner: HarnessOwner;
  /**
   * Projekt, für das die Vorschau aufgelöst wird. Fehlt es (globale oder
   * Kundenebene), zeigt die Komponente nur den Editor — eine Auflösung gibt es
   * per Definition nur aus Sicht eines Projekts.
   */
  resolveProjectId?: string;
}

type Draft = Pick<HarnessSection, 'key' | 'kind' | 'title' | 'body' | 'mergeStrategy' | 'order' | 'enabled'>;

const emptyDraft = (order: number): Draft => ({
  key: '',
  kind: 'prose',
  title: '',
  body: '',
  mergeStrategy: 'replace',
  order,
  enabled: true,
});

/**
 * `{}` vom Backend heisst „diese Ebene existiert noch nicht".
 *
 * Ein Prädikat, keine Behauptung: `value as Harness` wäre hier sogar TS-seitig
 * ein Fehler (die beiden Union-Zweige überlappen nicht), und ein Umweg über
 * `unknown` würde die Prüfung nur verstecken. `_id` ist das unterscheidende
 * Merkmal — die leere Antwort trägt es nie.
 */
function isHarness(value: Harness | Record<string, never>): value is Harness {
  return isRecord(value) && typeof value._id === 'string';
}

export default function HarnessView({ owner, resolveProjectId }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<'edit' | 'resolved'>('edit');
  const [harness, setHarness] = useState<Harness | null>(null);
  const [resolved, setResolved] = useState<ResolvedHarness | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft(0));
  const [saving, setSaving] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const ownerKey = `${owner.scope}:${owner.projectId ?? ''}:${owner.customerId ?? ''}:${resolveProjectId ?? ''}`;
  // Abgeleitet statt per Effect gesetzt: ein `setLoading(true)` im Effect ist
  // genau das Muster, das `react-hooks/set-state-in-effect` verbietet.
  const loading = loadedKey !== ownerKey;

  const load = useCallback(() => {
    return Promise.all([
      api.harness.get(owner),
      resolveProjectId ? api.harness.resolve(resolveProjectId) : Promise.resolve(null),
    ]).then(([raw, res]) => {
      setHarness(isHarness(raw) ? raw : null);
      setResolved(res);
      setLoadedKey(ownerKey);
    });
  }, [owner, resolveProjectId, ownerKey]);

  useEffect(() => {
    let cancelled = false;
    load().catch((err: unknown) => {
      if (!cancelled) {
        setError(errorMessage(err, t('common.errorLoading', { error: '' })));
        setLoadedKey(ownerKey);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load, ownerKey, reloadNonce, t]);

  const sections = [...(harness?.sections ?? [])].sort(
    (a, b) => a.order - b.order || a.key.localeCompare(b.key),
  );

  const startCreate = () => {
    const nextOrder = sections.length > 0 ? Math.max(...sections.map((s) => s.order)) + 10 : 10;
    setDraft(emptyDraft(nextOrder));
    setEditingKey('');
    setError(null);
  };

  const startEdit = (section: HarnessSection) => {
    setDraft({ ...section });
    setEditingKey(section.key);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.harness.sectionSet(owner, draft);
      setEditingKey(null);
      setReloadNonce((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err, t('common.errorSaving')));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (key: string) => {
    setError(null);
    try {
      await api.harness.sectionDelete(owner, key);
      setReloadNonce((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err, t('common.errorDeleting')));
    }
  };

  const move = async (section: HarnessSection, direction: -1 | 1) => {
    const index = sections.findIndex((s) => s.key === section.key);
    const other = sections[index + direction];
    if (!other) return;
    setError(null);
    try {
      // Beide Sections bekommen die Order der jeweils anderen. Zwei Aufrufe,
      // weil das Backend Sections einzeln adressiert — bewusst so, damit
      // gleichzeitige Bearbeitungen sich nicht gegenseitig überschreiben.
      await api.harness.sectionSet(owner, { ...section, order: other.order });
      await api.harness.sectionSet(owner, { ...other, order: section.order });
      setReloadNonce((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err, t('common.errorSaving')));
    }
  };

  const toggleEnabled = async (section: HarnessSection) => {
    setError(null);
    try {
      await api.harness.sectionSet(owner, { ...section, enabled: !section.enabled });
      setReloadNonce((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err, t('common.errorSaving')));
    }
  };

  if (loading) {
    return <div className="text-gray-500 text-sm py-8 text-center">{t('common.loading')}</div>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex gap-1">
          <Button
            variant={view === 'edit' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setView('edit')}
          >
            {t('harness.tabEdit')}
          </Button>
          {resolveProjectId && (
            <Button
              variant={view === 'resolved' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setView('resolved')}
            >
              {t('harness.tabResolved')}
            </Button>
          )}
        </div>
        {view === 'edit' && editingKey === null && (
          <Button variant="secondary" size="sm" onClick={startCreate}>
            {t('harness.addSection')}
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-4 bg-red-900/20 border border-red-800 rounded px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {view === 'edit' ? (
        <SectionEditor
          sections={sections}
          harness={harness}
          editingKey={editingKey}
          draft={draft}
          setDraft={setDraft}
          saving={saving}
          onSave={() => {
            void save();
          }}
          onCancel={() => setEditingKey(null)}
          onEdit={startEdit}
          onRemove={(key) => {
            void remove(key);
          }}
          onMove={(section, dir) => {
            void move(section, dir);
          }}
          onToggle={(section) => {
            void toggleEnabled(section);
          }}
        />
      ) : (
        <ResolvedPreview resolved={resolved} ownScope={owner.scope} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SectionEditor({
  sections,
  harness,
  editingKey,
  draft,
  setDraft,
  saving,
  onSave,
  onCancel,
  onEdit,
  onRemove,
  onMove,
  onToggle,
}: {
  sections: HarnessSection[];
  harness: Harness | null;
  editingKey: string | null;
  draft: Draft;
  setDraft: (d: Draft) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onEdit: (s: HarnessSection) => void;
  onRemove: (key: string) => void;
  onMove: (s: HarnessSection, dir: -1 | 1) => void;
  onToggle: (s: HarnessSection) => void;
}) {
  const { t } = useTranslation();
  const isCreating = editingKey === '';

  return (
    <div className="space-y-3">
      {!harness && !isCreating && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
          <p className="text-gray-400 mb-1">{t('harness.emptyLevel')}</p>
          <p className="text-gray-500 text-sm">{t('harness.emptyLevelHint')}</p>
        </div>
      )}

      {isCreating && (
        <SectionForm
          draft={draft}
          setDraft={setDraft}
          saving={saving}
          onSave={onSave}
          onCancel={onCancel}
          keyEditable
        />
      )}

      {sections.map((section, index) => {
        const isEditing = editingKey === section.key;
        return (
          <div
            key={section.key}
            className={`bg-gray-900 border rounded-lg p-4 ${
              section.enabled ? 'border-gray-800' : 'border-gray-800 opacity-60'
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-200 break-words">
                    {section.title || section.key}
                  </h3>
                  <span
                    className={`px-1.5 py-0.5 rounded border text-[11px] ${
                      KIND_BADGE[section.kind] ?? KIND_BADGE_FALLBACK
                    }`}
                  >
                    {section.kind}
                  </span>
                  {!section.enabled && (
                    <span className="px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-[11px] text-gray-400">
                      {t('harness.tombstone')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5 font-mono break-all">{section.key}</p>
              </div>

              {!isEditing && (
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onMove(section, -1)}
                    disabled={index === 0}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onMove(section, 1)}
                    disabled={index === sections.length - 1}
                  >
                    ↓
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => onToggle(section)}>
                    {section.enabled ? t('harness.disable') : t('harness.enable')}
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => onEdit(section)}>
                    {t('common.edit')}
                  </Button>
                  {/* `label`/`confirmLabel` als Props — ConfirmButton nimmt
                      keine children. */}
                  <ConfirmButton
                    size="xs"
                    label={t('common.delete')}
                    confirmLabel={t('common.confirmDelete')}
                    onConfirm={() => onRemove(section.key)}
                  />
                </div>
              )}
            </div>

            {isEditing ? (
              <SectionForm
                draft={draft}
                setDraft={setDraft}
                saving={saving}
                onSave={onSave}
                onCancel={onCancel}
                keyEditable={false}
              />
            ) : (
              <>
                <div className="text-xs text-gray-500 mb-2">
                  {t(`harness.merge.${section.mergeStrategy}Short`)}
                </div>
                {section.body.trim() ? (
                  <div className="max-h-64 overflow-y-auto">
                    <Markdown>{section.body}</Markdown>
                  </div>
                ) : (
                  <p className="text-sm text-gray-600 italic">{t('harness.sectionEmpty')}</p>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SectionForm({
  draft,
  setDraft,
  saving,
  onSave,
  onCancel,
  keyEditable,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  keyEditable: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FormInput
          label={t('harness.fieldKey')}
          value={draft.key}
          disabled={!keyEditable}
          onChange={(e) => setDraft({ ...draft, key: e.target.value })}
          helpText={t('harness.fieldKeyHint')}
        />
        <FormInput
          label={t('harness.fieldTitle')}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          helpText={t('harness.fieldTitleHint')}
        />
        <FormSelect
          label={t('harness.fieldKind')}
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: optionOr(e.target.value, EDITABLE_KINDS, 'prose') })}
        >
          {EDITABLE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`harness.kind.${k}`)}
            </option>
          ))}
        </FormSelect>
      </div>

      <div>
        <FormSelect
          label={t('harness.fieldMerge')}
          value={draft.mergeStrategy}
          onChange={(e) =>
            setDraft({ ...draft, mergeStrategy: optionOr(e.target.value, MERGE_STRATEGIES, 'replace') })
          }
        >
          {MERGE_STRATEGIES.map((m) => (
            <option key={m} value={m}>
              {t(`harness.merge.${m}`)}
            </option>
          ))}
        </FormSelect>
        {/* Die Strategie im Klartext, nicht nur als Enum-Wert im Dropdown. */}
        <p className="text-xs text-gray-500 mt-1">{t(`harness.merge.${draft.mergeStrategy}Hint`)}</p>
      </div>

      <MarkdownEditor
        value={draft.body}
        onChange={(value) => setDraft({ ...draft, body: value })}
        rows={8}
        placeholder={t('harness.fieldBodyPlaceholder')}
      />

      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving || !draft.key.trim()}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OriginTrail({ origin }: { origin: ResolvedSectionOrigin[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {origin.map((step, i) => (
        <span key={`${step.scope}-${step.customerId ?? ''}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-gray-600 text-xs">→</span>}
          <span className={`px-1.5 py-0.5 rounded border text-[11px] ${SCOPE_BADGE[step.scope]}`}>
            {t(`harness.scope.${step.scope}`)}
            {i > 0 && <span className="ml-1 opacity-75">{t(`harness.merge.${step.mergeStrategy}Short`)}</span>}
          </span>
        </span>
      ))}
    </div>
  );
}

function ResolvedPreview({
  resolved,
  ownScope,
}: {
  resolved: ResolvedHarness | null;
  ownScope: HarnessScope;
}) {
  const { t } = useTranslation();

  if (!resolved) {
    return <div className="text-gray-500 text-sm py-8 text-center">{t('harness.noPreview')}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
        <p className="text-xs text-gray-500 mb-2">{t('harness.chainLabel')}</p>
        {resolved.resolvedFrom.length === 0 ? (
          <p className="text-sm text-gray-600 italic">{t('harness.chainEmpty')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {resolved.resolvedFrom.map((level, i) => (
              <span key={`${level.scope}-${level.customerId ?? level.projectId ?? ''}-${i}`} className="flex items-center gap-1">
                {i > 0 && <span className="text-gray-600 text-xs">→</span>}
                <span className={`px-1.5 py-0.5 rounded border text-[11px] ${SCOPE_BADGE[level.scope]}`}>
                  {t(`harness.scope.${level.scope}`)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/*
        Abgeschaltete Sections werden ausgewiesen, nicht verschluckt. Eine
        geerbte Regel, die eine tiefere Ebene per Tombstone stillgelegt hat,
        wäre sonst spurlos verschwunden — und niemand fände heraus, warum.
      */}
      {resolved.suppressed.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
          <p className="text-xs text-gray-500 mb-2">{t('harness.suppressedLabel')}</p>
          <div className="flex flex-wrap gap-2">
            {resolved.suppressed.map((s) => (
              <span
                key={s.key}
                className="px-2 py-0.5 rounded border border-gray-700 bg-gray-800 text-xs text-gray-400 line-through"
              >
                {s.key}
              </span>
            ))}
          </div>
        </div>
      )}

      {resolved.sections.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center text-gray-500 text-sm">
          {t('harness.resolvedEmpty')}
        </div>
      ) : (
        resolved.sections.map((section) => (
          <div key={section.key} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-gray-200 break-words">
                  {section.title || section.key}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5 font-mono break-all">{section.key}</p>
              </div>
              <OriginTrail origin={section.origin} />
            </div>
            <div className="max-h-96 overflow-y-auto">
              <Markdown>{section.body}</Markdown>
            </div>
          </div>
        ))
      )}

      <p className="text-xs text-gray-600">
        {t('harness.ownScopeHint', { scope: t(`harness.scope.${ownScope}`) })}
      </p>
    </div>
  );
}
