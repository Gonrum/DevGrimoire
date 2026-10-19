import { WorkflowNodeMetadata } from '../../api/workflows';
import { isRecord } from '../../lib/narrow';
import { TemplateOption } from './TemplatePicker';

/** Ein Node, so wie Inspector und Edit-Modal ihn sehen. */
export interface SelectedNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  secretRefs?: string[];
}

/**
 * Trägt der Node-Typ überhaupt Einstellungen? Nur dann gibt es Stift und
 * Doppelklick-Modal. Ein Objekt-Schema ohne `properties` und ohne
 * `additionalProperties` hat nichts einzustellen.
 */
export function nodeHasConfig(meta: WorkflowNodeMetadata | undefined): boolean {
  if (!meta) return false;
  const schema = meta.configJsonSchema;
  if (schema.type !== 'object') return true;
  const props = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  return props.length > 0 || isRecord(schema.additionalProperties) || schema.additionalProperties === true;
}

/** Template-Pfade, die ein Node in seiner Config referenzieren kann. */
export function buildTemplateOptions(
  catalog: WorkflowNodeMetadata[],
  upstreamNodes: SelectedNode[],
): TemplateOption[] {
  const opts: TemplateOption[] = [
    { path: 'input.event.entityId', label: 'event.entityId', type: 'string' },
    { path: 'input.event.entity', label: 'event.entity', type: 'string' },
    { path: 'input.event.action', label: 'event.action', type: 'string' },
  ];
  for (const up of upstreamNodes) {
    const upMeta = catalog.find((c) => c.type === up.type);
    if (!upMeta) continue;
    for (const [outKey, outType] of Object.entries(upMeta.outputs)) {
      opts.push({
        path: `nodes.${up.id}.${outKey}`,
        label: `${up.id} / ${outKey}`,
        type: outType,
      });
    }
  }
  return opts;
}
