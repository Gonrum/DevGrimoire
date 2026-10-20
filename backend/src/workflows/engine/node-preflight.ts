import { NodeResult } from './types';
import { PlaceholderTrace, resolveConfig, ResolveOptions, ResolvedConfig } from '../nodes/template-resolver';
import { redactValue, SENSITIVE_KEY } from '../workflow-redaction';

/**
 * Spur vor dem Persistieren redigieren: `resolvedConfig` maskiert Werte unter
 * credential-artigen Schlüsseln, die Spur trägt denselben Wert aber im
 * `preview`. Liegt ein Segment von `field` auf so einem Schlüssel, wird der
 * Preview maskiert; sonst läuft die String-Redaction (Bearer, token=…).
 */
export function redactPlaceholders(traces: PlaceholderTrace[]): PlaceholderTrace[] {
  return traces.map((t) => {
    if (t.preview === undefined) return t;
    const sensitive = t.field.split('.').some((seg) => SENSITIVE_KEY.test(seg));
    return { ...t, preview: sensitive ? '[MASKED]' : redactValue(t.preview) };
  });
}

/**
 * Vorprüfung vor `executor.execute`: löst die Node-Config gegen den Lauf-Kontext
 * auf. Ein fehlender Pfad lässt den Node mit `template_unresolved` scheitern,
 * statt dass der Platzhalter wörtlich im Befehl/Titel landet. Secrets in einem
 * Node-Typ ohne Erlaubnis sind `secret_not_allowed` — und haben Vorrang, weil
 * sie ein Konfigurationsfehler sind, den auch ein anderer Lauf nicht behebt.
 */
export function preflightNode(
  config: Record<string, unknown>,
  runContext: Record<string, unknown>,
  opts: ResolveOptions & { nodeType: string },
): { resolved: ResolvedConfig; failure?: NodeResult } {
  const resolved = resolveConfig(config, runContext, {
    secrets: opts.secrets,
    secretsAllowed: opts.secretsAllowed,
  });
  if (resolved.forbiddenSecrets.length > 0) {
    return {
      resolved,
      failure: {
        status: 'failed',
        error: {
          code: 'secret_not_allowed',
          message: `Secrets sind in ${opts.nodeType} nicht erlaubt: ${resolved.forbiddenSecrets.join(', ')}`,
        },
      },
    };
  }
  if (resolved.missing.length > 0) {
    return {
      resolved,
      failure: {
        status: 'failed',
        error: {
          code: 'template_unresolved',
          message: `Platzhalter nicht auflösbar: ${resolved.missing.join(', ')}`,
        },
      },
    };
  }
  return { resolved };
}
