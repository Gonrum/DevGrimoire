import { Plus, Trash2 } from 'lucide-react';
import { TemplatePicker, TemplateOption } from './TemplatePicker';

type JsonSchema = Record<string, unknown>;

interface Props {
  schema: JsonSchema;
  path: (string | number)[];
  value: unknown;
  onChange: (newValue: unknown) => void;
  required?: boolean;
  fieldKey?: string;
  templateOptions?: TemplateOption[];
  /** Skip the outer label — used when an enclosing accordion section already shows the field name */
  hideLabel?: boolean;
}

const TEXTAREA_KEYS = new Set([
  'prompt', 'systemPrompt', 'description', 'content', 'message', 'body', 'title', 'text', 'summary',
]);

export function SchemaField({ schema, path, value, onChange, required, fieldKey, templateOptions = [], hideLabel = false }: Props) {
  const label = fieldKey ?? path[path.length - 1] ?? '';
  const labelText = hideLabel ? '' : String(label);

  if (schema.type === 'string' && Array.isArray(schema.enum)) {
    return (
      <Labeled label={labelText} required={required}>
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
        >
          <option value="">— wählen —</option>
          {(schema.enum as string[]).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </Labeled>
    );
  }

  if (schema.type === 'string' && schema.format === 'date-time') {
    const dtLocal = typeof value === 'string' && value ? value.slice(0, 16) : '';
    return (
      <Labeled label={labelText} required={required}>
        <input
          type="datetime-local"
          value={dtLocal}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200"
        />
      </Labeled>
    );
  }

  if (schema.type === 'string') {
    const useTextarea = TEXTAREA_KEYS.has(String(fieldKey ?? ''));
    const v = typeof value === 'string' ? value : '';
    return (
      <Labeled label={labelText} required={required}>
        <div className="flex items-start gap-1">
          {useTextarea ? (
            <textarea
              value={v}
              onChange={(e) => onChange(e.target.value)}
              rows={3}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
            />
          ) : (
            <input
              type="text"
              value={v}
              onChange={(e) => onChange(e.target.value)}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
            />
          )}
          <TemplatePicker
            options={templateOptions}
            onPick={(p) => onChange(v + p)}
          />
        </div>
      </Labeled>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <Labeled label={labelText} required={required}>
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={schema.minimum as number | undefined}
          max={schema.maximum as number | undefined}
          step={schema.type === 'integer' ? 1 : 'any'}
          onChange={(e) => {
            const n = e.target.value === '' ? undefined : Number(e.target.value);
            onChange(Number.isFinite(n as number) ? n : undefined);
          }}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
        />
      </Labeled>
    );
  }

  if (schema.type === 'boolean') {
    const checked = value === true;
    return (
      <Labeled label={labelText} required={required}>
        <button
          type="button"
          onClick={() => onChange(!checked)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-cyan-600' : 'bg-gray-700'}`}
        >
          <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </Labeled>
    );
  }

  if (schema.type === 'array') {
    const items = (schema.items ?? {}) as JsonSchema;
    const arr = Array.isArray(value) ? (value as unknown[]) : [];

    if (items.type === 'string') {
      return (
        <Labeled label={labelText} required={required}>
          <TagInput
            tags={arr.filter((x): x is string => typeof x === 'string')}
            onChange={(tags) => onChange(tags)}
          />
        </Labeled>
      );
    }

    return (
      <Labeled label={labelText} required={required}>
        <div className="space-y-2">
          {arr.map((item, idx) => (
            <div key={idx} className="rounded border border-gray-700 bg-gray-900/40 p-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">#{idx + 1}</span>
                <button
                  type="button"
                  onClick={() => {
                    const next = [...arr];
                    next.splice(idx, 1);
                    onChange(next);
                  }}
                  className="text-red-400 hover:text-red-300"
                  title="Eintrag löschen"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <SchemaField
                schema={items}
                path={[...path, idx]}
                value={item}
                onChange={(v) => {
                  const next = [...arr];
                  next[idx] = v;
                  onChange(next);
                }}
                templateOptions={templateOptions}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange([...arr, getEmpty(items)])}
            className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
          >
            <Plus size={12} /> hinzufügen
          </button>
        </div>
      </Labeled>
    );
  }

  if (schema.type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, JsonSchema>;
    const subReq = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const obj = (value as Record<string, unknown> | undefined) ?? {};
    return (
      <Labeled label={labelText} required={subReq.length > 0}>
        <fieldset className="rounded border border-gray-700 bg-gray-900/30 p-3 space-y-3">
          {Object.entries(props).map(([k, sub]) => (
            <SchemaField
              key={k}
              schema={sub}
              path={[...path, k]}
              value={obj[k]}
              onChange={(v) => onChange({ ...obj, [k]: v })}
              required={subReq.includes(k)}
              fieldKey={k}
              templateOptions={templateOptions}
            />
          ))}
        </fieldset>
      </Labeled>
    );
  }

  // Record / map: object with additionalProperties but no fixed properties.
  // Render as a key/value table where each row uses the additionalProperties
  // schema for the value. Used e.g. by action.user-question's `branchMap`.
  if (
    schema.type === 'object' &&
    !schema.properties &&
    schema.additionalProperties &&
    typeof schema.additionalProperties === 'object'
  ) {
    const valueSchema = schema.additionalProperties as JsonSchema;
    const obj = (value as Record<string, unknown> | undefined) ?? {};
    const entries = Object.entries(obj);
    const setEntries = (next: Array<[string, unknown]>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of next) {
        if (k.trim() !== '') out[k] = v;
      }
      onChange(Object.keys(out).length === 0 ? undefined : out);
    };
    return (
      <Labeled label={labelText} required={required}>
        <div className="space-y-2">
          {entries.length === 0 && (
            <div className="text-xs text-gray-600 italic">(keine Einträge — „hinzufügen" klicken)</div>
          )}
          {entries.map(([k, v], idx) => (
            <div key={idx} className="flex items-start gap-2 rounded border border-gray-700 bg-gray-900/40 p-2">
              <input
                type="text"
                value={k}
                placeholder="Schlüssel"
                onChange={(e) => {
                  const next = [...entries];
                  next[idx] = [e.target.value, v];
                  setEntries(next);
                }}
                className="w-1/3 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
              />
              <div className="flex-1">
                <SchemaField
                  schema={valueSchema}
                  path={[...path, k]}
                  value={v}
                  onChange={(nv) => {
                    const next = [...entries];
                    next[idx] = [k, nv];
                    setEntries(next);
                  }}
                  templateOptions={templateOptions}
                  hideLabel
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = entries.filter((_, i) => i !== idx);
                  setEntries(next);
                }}
                className="text-red-400 hover:text-red-300 mt-1"
                title="Eintrag entfernen"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setEntries([...entries, ['', getEmpty(valueSchema)]])}
            className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
          >
            <Plus size={12} /> hinzufügen
          </button>
        </div>
      </Labeled>
    );
  }

  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[];
    return (
      <Labeled label={labelText} required={required}>
        <div className="space-y-2">
          {variants.map((variant, idx) => (
            <SchemaField
              key={idx}
              schema={variant}
              path={[...path, `variant-${idx}`]}
              value={value}
              onChange={onChange}
              templateOptions={templateOptions}
            />
          ))}
        </div>
      </Labeled>
    );
  }

  // z.unknown() / no-type fallback: render a single-line input that tries to
  // interpret the entered text as JSON (number, boolean, array, object,
  // quoted-string), otherwise stores the raw string. Used e.g. by
  // control.condition's `value` field where the right-hand-side type depends
  // on the operator.
  const renderedValue =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  return (
    <Labeled label={labelText} required={required}>
      <input
        type="text"
        value={renderedValue}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(undefined);
            return;
          }
          // Numbers / booleans / null / JSON literals → parse. Otherwise keep
          // as plain string so users don't have to wrap normal text in quotes.
          const trimmed = raw.trim();
          if (
            trimmed === 'true' ||
            trimmed === 'false' ||
            trimmed === 'null' ||
            /^-?\d+(\.\d+)?$/.test(trimmed) ||
            trimmed.startsWith('"') ||
            trimmed.startsWith('[') ||
            trimmed.startsWith('{')
          ) {
            try {
              onChange(JSON.parse(trimmed));
              return;
            } catch {
              /* fall through to raw string */
            }
          }
          onChange(raw);
        }}
        placeholder="Wert (Text · Zahl · true/false · oder JSON)"
        className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
      />
    </Labeled>
  );
}

function Labeled({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  if (!label) return <>{children}</>;
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}

function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded border border-gray-700 bg-gray-800 px-2 py-1">
      {tags.map((t, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-200">
          {t}
          <button
            type="button"
            onClick={() => onChange(tags.filter((_, j) => j !== i))}
            className="text-gray-400 hover:text-red-400"
          >×</button>
        </span>
      ))}
      <input
        type="text"
        placeholder="+ Tag (Enter)"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const v = (e.target as HTMLInputElement).value.trim();
            if (v && !tags.includes(v)) onChange([...tags, v]);
            (e.target as HTMLInputElement).value = '';
          }
        }}
        className="flex-1 bg-transparent text-sm text-gray-200 focus:outline-none"
      />
    </div>
  );
}

function getEmpty(schema: JsonSchema): unknown {
  if (schema.type === 'object') return {};
  if (schema.type === 'array') return [];
  if (schema.type === 'string') return '';
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  return null;
}
