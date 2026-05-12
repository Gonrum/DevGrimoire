#!/usr/bin/env node
/*
 * Regression check for the MCP Roots workspace guard (T-267).
 *
 * Runs without a live backend or database: requires the compiled
 * workspace-roots.guard.js from dist/ and exercises both the exported entry
 * point assertWorkspaceWithinClientRoots and the internal helpers used by it.
 *
 * Run with `npm run check:workspace-roots-guard` from backend/ after a build.
 */
const path = require('node:path');

const guardPath = path.resolve(__dirname, '..', 'dist', 'workspaces', 'workspace-roots.guard.js');
let guardModule;
try {
  guardModule = require(guardPath);
} catch (err) {
  console.error(`Failed to load compiled guard at ${guardPath}.`);
  console.error('Run `npm run build` in backend/ first.');
  console.error(err.message);
  process.exit(2);
}

const { assertWorkspaceWithinClientRoots, workspaceRootsGuardTestInternals } = guardModule;
const { normalizeWorkspacePath, fileUriToPath, isSameOrChildPath, workspaceTargetPath } =
  workspaceRootsGuardTestInternals;

let failures = 0;
let total = 0;

function check(label, fn) {
  total += 1;
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectAllowed(ws, roots, options) {
  assertWorkspaceWithinClientRoots(ws, roots, options);
}

function expectBlocked(ws, roots, options) {
  let threw = false;
  try {
    assertWorkspaceWithinClientRoots(ws, roots, options);
  } catch (err) {
    threw = true;
    assert(
      /blocked by MCP client roots/i.test(err.message),
      `expected roots-block error, got: ${err.message}`,
    );
  }
  assert(threw, 'expected guard to throw, but it allowed access');
}

function expectEscapeBlocked(ws, roots, options) {
  let threw = false;
  try {
    assertWorkspaceWithinClientRoots(ws, roots, options);
  } catch (err) {
    threw = true;
    assert(
      /escapes workspace base/i.test(err.message),
      `expected escape-block error, got: ${err.message}`,
    );
  }
  assert(threw, 'expected guard to throw, but it allowed access');
}

const wsFactory = (overrides = {}) => ({
  _id: { toString: () => overrides.id || 'ws-1' },
  path: overrides.path,
  repoUrl: overrides.repoUrl,
});

// --- helper invariants ---------------------------------------------------

check('normalizeWorkspacePath strips trailing slash but keeps root', () => {
  assert(normalizeWorkspacePath('/foo/bar/') === '/foo/bar', 'trailing slash should be trimmed');
  assert(normalizeWorkspacePath('/') === '/', 'root stays as /');
  assert(normalizeWorkspacePath('foo/bar') === '/foo/bar', 'leading slash should be added');
});

check('fileUriToPath only accepts file://', () => {
  assert(fileUriToPath('file:///srv/work') === '/srv/work', 'file:// URI should yield path');
  assert(fileUriToPath('https://example.com/repo') === undefined, 'http(s) URIs must not be paths');
  assert(fileUriToPath('not-a-uri') === undefined, 'malformed URIs must not throw');
});

check('isSameOrChildPath matches subpaths only', () => {
  assert(isSameOrChildPath('/srv/work/sub', '/srv/work') === true, 'subpath should match');
  assert(isSameOrChildPath('/srv/work', '/srv/work') === true, 'same path should match');
  assert(isSameOrChildPath('/srv/worker', '/srv/work') === false, 'prefix-without-slash should NOT match');
  assert(isSameOrChildPath('/etc/passwd', '/srv/work') === false, 'unrelated path must not match');
});

check('workspaceTargetPath joins relative paths safely', () => {
  const ws = wsFactory({ path: '/srv/work' });
  assert(workspaceTargetPath(ws) === '/srv/work', 'base path returned without rel');
  assert(workspaceTargetPath(ws, 'src/app.ts') === '/srv/work/src/app.ts', 'simple join');
  // posix.join normalizes ../; this is the guard's safety net.
  assert(
    workspaceTargetPath(ws, '../escape') === '/srv/escape',
    '../ inside relativePath is resolved (callers must additionally reject escapes upstream)',
  );
});

check('workspaceTargetPath falls back to /workspaces/<id>', () => {
  const ws = wsFactory({ id: 'abc' });
  assert(workspaceTargetPath(ws) === '/workspaces/abc', 'fallback id-based path');
});

// --- main contract -------------------------------------------------------

check('no roots → no-op (backwards compatible)', () => {
  expectAllowed(wsFactory({ path: '/srv/work' }), undefined);
  expectAllowed(wsFactory({ path: '/srv/work' }), []);
});

check('workspace path within file:// root is allowed', () => {
  expectAllowed(
    wsFactory({ path: '/srv/work' }),
    [{ uri: 'file:///srv/work' }],
  );
  expectAllowed(
    wsFactory({ path: '/srv/work/sub' }),
    [{ uri: 'file:///srv/work' }],
  );
});

check('server-managed workspace allowed when client roots only declare unrelated client-side paths (T-285)', () => {
  // The classic Claude-Code scenario: client lives on its own filesystem
  // (e.g. file:///D:/Projects/foo) and never speaks about the server's
  // /workspaces/* namespace. Disjoint roots must not deny by default.
  expectAllowed(
    wsFactory({ path: '/workspaces/abc' }),
    [{ uri: 'file:///D:/Projects/csharp/repos/foo' }],
  );
  expectAllowed(
    wsFactory({ path: '/etc' }),
    [{ uri: 'file:///srv/work' }, { uri: 'file:///home/dev' }],
  );
});

check('sibling-prefix paths (/srv/worker vs /srv/work) are allowed (disjoint namespaces — T-285)', () => {
  // Siblings share no hierarchical relationship — the client root is not
  // narrowing this workspace at all, so the guard should not deny.
  expectAllowed(
    wsFactory({ path: '/srv/worker' }),
    [{ uri: 'file:///srv/work' }],
  );
});

check('overlapping file root narrows access: parent workspace, sub-folder root → workspace base is blocked', () => {
  // Client narrows access to /srv/work/sub; targeting the wider workspace
  // base /srv/work must still be blocked. This preserves the narrowing
  // semantics within a shared namespace.
  expectBlocked(
    wsFactory({ path: '/srv/work' }),
    [{ uri: 'file:///srv/work/sub' }],
  );
});

check('overlapping file root narrows access: relativePath into the allowed sub-folder is allowed', () => {
  expectAllowed(
    wsFactory({ path: '/srv/work' }),
    [{ uri: 'file:///srv/work/sub' }],
    { relativePath: 'sub/app.ts' },
  );
});

check('repoUrl prefix is honored when no file:// root matches', () => {
  expectAllowed(
    wsFactory({ path: '/etc', repoUrl: 'https://github.com/me/repo' }),
    [{ uri: 'https://github.com/me/repo' }],
  );
  expectAllowed(
    wsFactory({ path: '/etc', repoUrl: 'https://github.com/me/repo.git' }),
    [{ uri: 'https://github.com/me/repo.git' }],
  );
});

check('repoUrl not covered by any root is blocked', () => {
  expectBlocked(
    wsFactory({ path: '/etc', repoUrl: 'https://github.com/other/repo' }),
    [{ uri: 'https://github.com/me/repo' }],
  );
});

check('relativePath inside a root is allowed', () => {
  expectAllowed(
    wsFactory({ path: '/srv/work' }),
    [{ uri: 'file:///srv/work' }],
    { relativePath: 'src/app.ts' },
  );
});

check('relativePath that escapes via ../ is blocked even when a client root would otherwise allow', () => {
  expectEscapeBlocked(
    wsFactory({ path: '/srv/work' }),
    [{ uri: 'file:///srv/work' }],
    { relativePath: '../escape' },
  );
});

check('relativePath ../ is blocked even with no client roots at all (server-side invariant — T-285)', () => {
  // Path-traversal protection must not depend on the client having
  // declared roots — otherwise old/stdio clients lose the safety net.
  expectEscapeBlocked(
    wsFactory({ path: '/workspaces/abc' }),
    undefined,
    { relativePath: '../../etc/passwd' },
  );
  expectEscapeBlocked(
    wsFactory({ path: '/workspaces/abc' }),
    [],
    { relativePath: '../other' },
  );
});

check('relativePath ../ is blocked even when client roots are disjoint from workspace', () => {
  expectEscapeBlocked(
    wsFactory({ path: '/workspaces/abc' }),
    [{ uri: 'file:///D:/Projects/foo' }],
    { relativePath: '../../etc' },
  );
});

check('multiple roots: any match allows', () => {
  expectAllowed(
    wsFactory({ path: '/srv/work/sub' }),
    [{ uri: 'file:///home/dev' }, { uri: 'file:///srv/work' }],
  );
});

check('error message does not leak workspace path (roots-block)', () => {
  // Use a narrowing root that overlaps with the workspace base, so the
  // roots-block path actually triggers (T-285 changed the disjoint case
  // to be allowed).
  let captured;
  try {
    assertWorkspaceWithinClientRoots(
      wsFactory({ path: '/srv/private-customer-data' }),
      [{ uri: 'file:///srv/private-customer-data/public-subdir' }],
    );
  } catch (err) {
    captured = err.message;
  }
  assert(captured, 'guard should throw');
  assert(
    !captured.includes('/srv/private-customer-data'),
    `error must not include workspace path: ${captured}`,
  );
});

check('error message does not leak workspace path (escape-block)', () => {
  let captured;
  try {
    assertWorkspaceWithinClientRoots(
      wsFactory({ path: '/srv/private-customer-data' }),
      undefined,
      { relativePath: '../escape' },
    );
  } catch (err) {
    captured = err.message;
  }
  assert(captured, 'guard should throw');
  assert(
    !captured.includes('/srv/private-customer-data'),
    `error must not include workspace path: ${captured}`,
  );
});

// --- summary -------------------------------------------------------------

if (failures > 0) {
  console.error(`\nworkspace-roots guard check FAILED: ${failures}/${total} assertions failed.`);
  process.exit(1);
}
console.log(`\nworkspace-roots guard check passed: ${total}/${total} assertions.`);
