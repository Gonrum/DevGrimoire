#!/usr/bin/env node
/*
 * Container-only guard (SSH-Werkstatt, Task 2).
 *
 * Part 1 (behaviour): assertContainerWorkspace / ...WithSlug and the token/env
 * builders reject SSH workspaces with a 409 and leave container workspaces
 * (and legacy documents without `location`) alone.
 *
 * Part 2 (static completeness, over the sources in src/):
 *  - Every file that calls WorkspaceClient methods (`workspaceClient.` or
 *    `this.client.`) must contain `assertContainerWorkspace(` or go through the
 *    guarded resolver. Excluded: the client itself, workspace-fs.controller.ts,
 *    fs/**, workspace-ttl.scheduler.ts, and main.ts (the terminal upgrade);
 *    later tasks replace those code paths.
 *  - mcp-tools.ts and chat-tools.ts load workspaces for sidecar tools ONLY via
 *    one guarded resolver (`loadContainerWorkspace`). Heuristic: every
 *    `workspaceClient.<m>(` call site must have, between the nearest preceding
 *    `case '` label (the tool branch) and the call, a call to the resolver.
 *    The resolver's definition must itself contain `assertContainerWorkspace`.
 *
 * Loads from dist/; run `npm run build` first. No database, no network.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const SRC = path.resolve(__dirname, '..', 'src');
const load = (rel) => {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.\n${err.message}`);
    process.exit(2);
  }
};

let failures = 0;
async function t(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (err) {
    failures++; console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');

(async () => {
  let mod;
  try { mod = load('workspaces/container-only.js'); } catch { /* handled below */ }
  await t('container-only module exists', () => assert.ok(mod?.assertContainerWorkspace));
  if (mod) {
    const { assertContainerWorkspace, assertContainerWorkspaceWithSlug } = mod;
    await t('ssh workspace -> 409 with exact message', () => {
      assert.throws(
        () => assertContainerWorkspace({ location: 'ssh', name: 'x' }),
        (e) => e.getStatus() === 409 &&
          e.message === 'SSH-Werkstatt "x": dieses Werkzeug arbeitet nur mit Container-Werkstätten; nutze die ssh_*-Tools',
      );
    });
    await t('slug is appended', () => {
      assert.throws(
        () => assertContainerWorkspace({ location: 'ssh', name: 'x' }, 'prod'),
        (e) => e.message.endsWith('nutze die ssh_*-Tools mit Verbindung "prod"'),
      );
    });
    await t('container and legacy (no location) pass', () => {
      assertContainerWorkspace({ location: 'container', name: 'x' });
      assertContainerWorkspace({ name: 'x' });
    });
    await t('slug lookup failure keeps the 409', async () => {
      await assert.rejects(
        assertContainerWorkspaceWithSlug({ location: 'ssh', name: 'x', sshConnectionId: 'a' }, async () => { throw new Error('boom'); }),
        (e) => e.getStatus() === 409 && !e.message.includes('Verbindung'),
      );
      await assert.rejects(
        assertContainerWorkspaceWithSlug({ location: 'ssh', name: 'x', sshConnectionId: 'a' }, async () => ({ slug: 's1' })),
        (e) => e.getStatus() === 409 && e.message.includes('"s1"'),
      );
    });

    const { WorkspaceCliTokenService } = load('workspaces/workspace-cli-token.service.js');
    const { WorkspaceGitTokensService } = load('workspaces/workspace-git-tokens.service.js');
    const sshWs = { _id: 'w1', projectId: 'p1', location: 'ssh', name: 'x' };
    await t('CLI token env refuses ssh workspace', () => {
      process.env.JWT_SECRET = 'test-secret';
      const svc = new WorkspaceCliTokenService({ sign: () => 'tok' });
      assert.throws(() => svc.buildEnvFor(sshWs), (e) => e.getStatus() === 409);
      assert.ok(svc.buildEnvFor({ ...sshWs, location: 'container' }).DG_API_TOKEN);
    });
    await t('git token env + clone URL refuse ssh workspace', async () => {
      const svc = new WorkspaceGitTokensService({}, {});
      await assert.rejects(svc.resolveForWorkspace(sshWs), (e) => e.getStatus() === 409);
      await assert.rejects(svc.resolveCloneAuth(sshWs, 'https://h/r.git'), (e) => e.getStatus() === 409);
    });
  }

  // ---- static completeness -------------------------------------------------
  const EXCLUDED = (r) =>
    r === 'workspaces/workspace-client.service.ts' ||
    r === 'workspaces/workspace-fs.controller.ts' ||
    r.startsWith('workspaces/fs/') ||
    r === 'workspaces/workspace-ttl.scheduler.ts' ||
    r === 'main.ts' ||
    r === 'workspaces/container-only.ts';
  const CALL = /\b(?:this\.)?workspaceClient\.\w+\(|this\.client\.\w+\(/g;
  const RESOLVER = ['mcp-tools.ts', 'chat/chat-tools.ts'];

  for (const file of walk(SRC)) {
    const r = rel(file);
    if (EXCLUDED(r)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!/\bWorkspaceClient\b/.test(text)) continue;
    if (!CALL.test(text)) { CALL.lastIndex = 0; continue; }
    CALL.lastIndex = 0;
    if (RESOLVER.includes(r)) continue; // stricter check below
    await t(`${r}: sidecar callers contain assertContainerWorkspace[WithSlug](`, () => {
      assert.ok(/assertContainerWorkspace(?:WithSlug)?\(/.test(text), `${r} calls WorkspaceClient without the guard`);
    });
  }

  for (const r of RESOLVER) {
    const text = fs.readFileSync(path.join(SRC, r), 'utf8');
    await t(`${r}: resolver definition contains the guard`, () => {
      const def = text.search(/function loadContainerWorkspace|loadContainerWorkspace\(\s*[a-z]+:|private async loadContainerWorkspace|async loadContainerWorkspace/);
      assert.ok(def >= 0, 'loadContainerWorkspace is not defined');
      assert.ok(text.slice(def, def + 900).includes('assertContainerWorkspace'), 'resolver lacks the guard');
    });
    await t(`${r}: every workspaceClient call follows the resolver in its tool branch`, () => {
      const bad = [];
      let m; const re = /\b(?:this\.)?workspaceClient\.\w+\(/g;
      while ((m = re.exec(text))) {
        const caseAt = text.lastIndexOf("case '", m.index);
        const branch = text.slice(caseAt, m.index);
        if (caseAt < 0 || !branch.includes('loadContainerWorkspace(')) {
          bad.push(text.slice(caseAt, caseAt + 40).split('\n')[0] + ' -> ' + m[0]);
        }
      }
      assert.deepEqual(bad, []);
    });
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall container-only checks passed');
})();
