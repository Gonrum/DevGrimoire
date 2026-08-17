#!/usr/bin/env node
/*
 * Regressions-Check: kein Tool wird dem LLM ohne Definition angeboten.
 *
 * Hintergrund (gefunden in M-52 / T-457): alle 15 `customer_*`/`contact_*`-Tools
 * standen in `TOOL_GROUPS` — und damit in `ALL_TOOL_NAMES` —, hatten aber keinen
 * Eintrag in `TOOL_DEFINITIONS`. `getToolsForLlm()` baute daraus
 * `{ type: 'function', function: undefined }`. Sechs davon stehen in
 * `DEFAULT_TOOLS_ALLOWLIST`, und der Anthropic-Adapter in
 * `balancer/llm-client.service.ts` liest `t.function.name` — jeder tool-fähige
 * Chat mit der Default-Allowlist lief damit in einen TypeError.
 *
 * Der Typ hat das verdeckt: `Record<string, ToolDefinition>` verspricht eine
 * totale Index-Signatur, und `tsconfig.json` setzt kein
 * `noUncheckedIndexedAccess`. Deshalb dieser Check statt Vertrauen auf tsc.
 *
 * Lädt aus dist/ — vorher bauen. Läuft über `npm run check:chat-tool-definitions`.
 */
const assert = require('node:assert');
const m = require('../dist/chat/chat-tools');

const { ALL_TOOL_NAMES, TOOL_DEFINITIONS, ChatToolsService } = m;
assert.ok(Array.isArray(ALL_TOOL_NAMES) && ALL_TOOL_NAMES.length > 0, 'ALL_TOOL_NAMES leer');
assert.ok(TOOL_DEFINITIONS && typeof TOOL_DEFINITIONS === 'object', 'TOOL_DEFINITIONS fehlt');

// --- 1) getToolsForLlm liefert niemals ein Tool ohne Definition -------------
// Die Methode braucht keinen Service-State, deshalb genügt der Prototyp.
const getToolsForLlm = ChatToolsService.prototype.getToolsForLlm;
assert.strictEqual(typeof getToolsForLlm, 'function', 'getToolsForLlm fehlt');

const fakeThis = { logger: { warn() {} } };
const offered = getToolsForLlm.call(fakeThis, ALL_TOOL_NAMES);

const broken = offered.filter((t) => !t.function || typeof t.function.name !== 'string');
assert.deepStrictEqual(
  broken,
  [],
  `getToolsForLlm hat ${broken.length} Tools ohne Definition ausgeliefert — der Anthropic-Adapter liest t.function.name und würde werfen`,
);

// --- 2) Die Anthropic-Übersetzung läuft ohne Wurf durch --------------------
// Exakt die Abbildung aus balancer/llm-client.service.ts.
const anthropicTools = offered.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));
assert.ok(
  anthropicTools.every((t) => typeof t.name === 'string' && t.name.length > 0),
  'Anthropic-Mapping ergibt Tools ohne Namen',
);

// --- 3) Der Kunden-Kontext aus DEFAULT_TOOLS_ALLOWLIST ist angeboten -------
// Diese sechs haben funktionierende dispatch()-Cases und stehen bewusst in der
// Default-Allowlist; genau ihnen fehlten die Definitionen.
const CUSTOMER_CONTEXT_READ = [
  'customer_list',
  'customer_get',
  'contact_list',
  'contact_get',
  'customer_project_list',
  'project_customer_links',
];
const offeredNames = new Set(offered.map((t) => t.function.name));
for (const name of CUSTOMER_CONTEXT_READ) {
  assert.ok(TOOL_DEFINITIONS[name], `TOOL_DEFINITIONS fehlt ${name}`);
  assert.ok(offeredNames.has(name), `getToolsForLlm bietet ${name} nicht an`);
}

// --- 4) Definition und Schlüssel müssen denselben Namen tragen -------------
// Ein Copy-Paste-Fehler hier würde dem LLM einen Namen anbieten, den dispatch()
// nie erreicht.
for (const [key, def] of Object.entries(TOOL_DEFINITIONS)) {
  assert.strictEqual(def.name, key, `TOOL_DEFINITIONS["${key}"].name ist "${def.name}"`);
}

// --- 5) Tote Allowlist-Fläche berichten, nicht erzwingen -------------------
// Namen ohne Definition sind erlaubt (sie werden übersprungen), aber sie sind
// ein Signal: entweder Definition nachziehen oder aus TOOL_GROUPS entfernen.
const withoutDefinition = ALL_TOOL_NAMES.filter((n) => !TOOL_DEFINITIONS[n]);
if (withoutDefinition.length > 0) {
  console.log(
    `Hinweis: ${withoutDefinition.length} Tools in ALL_TOOL_NAMES ohne Definition ` +
      `(werden dem LLM nicht angeboten): ${withoutDefinition.join(', ')}`,
  );
}

console.log(
  `chat-tool-definitions-check OK — ${offered.length} von ${ALL_TOOL_NAMES.length} Tools angeboten, alle mit Definition`,
);
