import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { isRecord, isUnknownArray } from '../../lib/narrow';
import { SchemaField } from './SchemaField';
import { TemplateOption } from './TemplatePicker';

type JsonSchema = Record<string, unknown>;

/** Ein Teil-Schema; alles, was kein Objekt ist, wird zum leeren Schema. */
function asSchema(value: unknown): JsonSchema {
  return isRecord(value) ? value : {};
}

interface Props {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  templateOptions?: TemplateOption[];
}

/**
 * Top-level renderer for an object schema: each property becomes its own
 * collapsible accordion section. Required properties default-open, optional
 * ones default-closed.
 *
 * Falls back to plain SchemaField for non-object schemas (caller's responsibility
 * to check schema.type first — this component assumes object).
 */
export function SchemaObjectAccordion({ schema, value, onChange, templateOptions = [] }: Props) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = isUnknownArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];

  // sort required first, then by original property order
  const propNames = Object.keys(properties).sort((a, b) => {
    const aReq = required.includes(a) ? 0 : 1;
    const bReq = required.includes(b) ? 0 : 1;
    return aReq - bReq;
  });

  const propsWithMeta = propNames.map((name) => ({
    name,
    schema: asSchema(properties[name]),
    required: required.includes(name),
  }));

  if (propsWithMeta.length === 0) {
    return <div className="rounded border border-gray-800 bg-gray-900/30 p-3 text-xs text-gray-500">Kein konfigurierbares Feld.</div>;
  }

  return (
    <div className="space-y-1">
      {propsWithMeta.map(({ name, schema: sub, required: isReq }) => (
        <AccordionSection
          key={name}
          fieldKey={name}
          schema={sub}
          required={isReq}
          value={value?.[name]}
          onChange={(v) => onChange({ ...value, [name]: v })}
          templateOptions={templateOptions}
        />
      ))}
    </div>
  );
}

interface SectionProps {
  fieldKey: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  templateOptions: TemplateOption[];
}

function AccordionSection({ fieldKey, schema, required, value, onChange, templateOptions }: SectionProps) {
  const [open, setOpen] = useState(required);
  const summary = describeValue(value, schema);

  return (
    <div className={`rounded border ${required ? 'border-gray-700' : 'border-gray-800'} bg-gray-900/40`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-900"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />}
          <span className="text-xs uppercase tracking-wide text-gray-300">{fieldKey}</span>
          {required && <span className="text-[10px] text-red-400">*</span>}
        </div>
        {!open && summary && <span className="truncate text-xs text-gray-500 font-mono">{summary}</span>}
      </button>
      {open && (
        <div className="border-t border-gray-800 px-3 py-3">
          <SchemaField
            schema={schema}
            path={[fieldKey]}
            value={value}
            onChange={onChange}
            required={required}
            fieldKey={fieldKey}
            templateOptions={templateOptions}
            hideLabel
          />
        </div>
      )}
    </div>
  );
}

/** Generates a compact one-line preview of the current value for the collapsed header. */
function describeValue(value: unknown, schema: JsonSchema): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    if (!value) return '';
    return value.length > 40 ? `"${value.slice(0, 37)}…"` : `"${value}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (isRecord(schema.items) && schema.items.type === 'string') return `[${value.length}: ${value.slice(0, 3).join(', ')}${value.length > 3 ? '…' : ''}]`;
    return `[${value.length} Einträge]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return keys.length === 0 ? '{}' : `{${keys.length} Felder}`;
  }
  return '';
}
