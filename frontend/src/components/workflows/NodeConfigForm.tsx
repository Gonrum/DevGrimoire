import { WorkflowNodeMetadata } from '../../api/workflows';
import { isRecord } from '../../lib/narrow';
import { SchemaField } from './SchemaField';
import { SchemaObjectAccordion } from './SchemaObjectAccordion';
import { TemplateOption } from './TemplatePicker';

interface Props {
  meta: WorkflowNodeMetadata;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  templateOptions: TemplateOption[];
}

/** Die Config-Form eines Nodes — geteilt von Seitenpanel und Edit-Modal. */
export function NodeConfigForm({ meta, config, onChange, templateOptions }: Props) {
  if (meta.configJsonSchema.type === 'object') {
    return (
      <SchemaObjectAccordion
        schema={meta.configJsonSchema}
        value={config ?? {}}
        onChange={onChange}
        templateOptions={templateOptions}
      />
    );
  }
  return (
    <SchemaField
      schema={meta.configJsonSchema}
      path={['config']}
      value={config}
      onChange={(v) => {
        // `SchemaField` meldet `undefined`, wenn die letzte Zeile
        // einer additionalProperties-Map gelöscht wird. Vorher ging
        // dieses `undefined` als "Config" durch — hier wird daraus
        // die leere Config, die es meint.
        onChange(isRecord(v) ? v : {});
      }}
      templateOptions={templateOptions}
    />
  );
}
