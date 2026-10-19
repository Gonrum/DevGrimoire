#!/usr/bin/env node
/**
 * Versionssprung nur bei echten Ablauf-Änderungen.
 *
 * `runtimeFingerprint` ignoriert Layout (Position, Labels, ui) sowie Reihenfolge
 * von Nodes/Edges und Schlüsseln, erkennt aber jede Änderung an Typ, Config,
 * Secrets, Verbindungen, Bedingungen, Mapping und Trigger.
 *
 * Läuft gegen `dist/`, ohne Nest/Mongo. Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');
const { runtimeFingerprint } = require('../dist/workflows/workflow-runtime-fingerprint');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

const base = () => ({
  trigger: { type: 'manual' },
  nodes: [
    { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
    {
      id: 'exec', type: 'ssh.exec', label: 'Deploy', position: { x: 100, y: 0 },
      config: { connectionId: 'c1', command: 'ls' }, secretRefs: [], ui: { color: 'red' },
    },
  ],
  edges: [
    { id: 'e1', source: 't', target: 'exec', sourcePort: 'success', branch: 'success', label: 'los' },
  ],
});
const fp = (d) => runtimeFingerprint(d);
const same = (mutate) => { const d = base(); mutate(d); assert.equal(fp(d), fp(base())); };
const differs = (mutate) => { const d = base(); mutate(d); assert.notEqual(fp(d), fp(base())); };

check('Node verschieben ändert nichts', () => same((d) => { d.nodes[1].position = { x: 999, y: 5 }; }));
check('Node-Label und ui ändern nichts', () => same((d) => { d.nodes[1].label = 'Neu'; d.nodes[1].ui = {}; }));
check('Edge-Label und Edge-id ändern nichts', () => same((d) => { d.edges[0].label = 'x'; d.edges[0].id = 'e9'; }));
check('Reihenfolge von Nodes und Config-Schlüsseln ändert nichts', () => same((d) => {
  d.nodes.reverse();
  d.nodes[0].config = { command: 'ls', connectionId: 'c1' };
}));
check('undefined-Felder zählen wie fehlende', () => same((d) => { d.nodes[1].config.cwd = undefined; }));

check('Befehl ändern zählt', () => differs((d) => { d.nodes[1].config.command = 'ls -al'; }));
check('Node-Typ ändern zählt', () => differs((d) => { d.nodes[1].type = 'action.log'; }));
check('Secret-Ref hinzufügen zählt', () => differs((d) => { d.nodes[1].secretRefs = ['s1']; }));
check('Node hinzufügen zählt', () => differs((d) => { d.nodes.push({ id: 'n', type: 'action.log', position: { x: 0, y: 0 } }); }));
check('Edge entfernen zählt', () => differs((d) => { d.edges = []; }));
check('Branch ändern zählt', () => differs((d) => { d.edges[0].branch = 'failure'; }));
check('Bedingung setzen zählt', () => differs((d) => { d.edges[0].condition = { op: 'eq' }; }));
check('payloadMapping setzen zählt', () => differs((d) => { d.edges[0].payloadMapping = { a: 'b' }; }));
check('Trigger ändern zählt', () => differs((d) => { d.trigger = { type: 'schedule', cron: '0 * * * *' }; }));

console.log(`${passed} checks passed`);
