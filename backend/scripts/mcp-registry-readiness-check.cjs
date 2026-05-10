#!/usr/bin/env node
const baseUrl = (process.env.DEVGRIMOIRE_BASE_URL || process.env.BASE_URL || 'http://localhost:3200').replace(/\/$/, '');
const forbiddenKeys = new Set(['apiKey', 'api_key', 'token', 'jwt', 'password', 'secret', 'authorization']);
const secretPatterns = [/cv_[A-Za-z0-9_-]{12,}/, /Bearer\s+\S+/i, /sk-[A-Za-z0-9_-]{16,}/];

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
  return res.json();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function walk(value, path = '$') {
  if (typeof value === 'string') {
    for (const pattern of secretPatterns) {
      assert(!pattern.test(value), `secret-like value found at ${path}`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert(!forbiddenKeys.has(key.toLowerCase()), `forbidden key '${key}' found at ${path}`);
    walk(child, `${path}.${key}`);
  }
}

(async () => {
  const discovery = await getJson('/.well-known/mcp');
  assert(discovery.schemaVersion === 'devgrimoire.mcp.discovery.v1', 'unexpected discovery schemaVersion');
  assert(discovery.name === 'DevGrimoire', 'unexpected discovery name');
  assert(Array.isArray(discovery.transports) && discovery.transports.length >= 1, 'discovery transports missing');
  assert(discovery.capabilities?.tools === true, 'discovery tools capability missing');
  assert(discovery.privacy?.public === true, 'discovery privacy.public must be true');
  assert(discovery.privacy?.containsSecrets === false, 'discovery must declare containsSecrets=false');
  walk(discovery);

  const manifest = await getJson('/server.json');
  assert(typeof manifest.$schema === 'string' && manifest.$schema.includes('/server.schema.json'), 'server.json $schema missing');
  assert(manifest.name === 'local.devgrimoire/devgrimoire', 'server.json name must stay private/local namespace');
  assert(manifest.title === 'DevGrimoire', 'server.json title missing');
  assert(typeof manifest.version === 'string' && manifest.version.length > 0, 'server.json version missing');
  assert(Array.isArray(manifest.remotes) && manifest.remotes.length >= 1, 'server.json remotes missing');
  for (const remote of manifest.remotes) {
    assert(['streamable-http', 'sse'].includes(remote.type), `unsupported remote type ${remote.type}`);
    assert(typeof remote.url === 'string' && remote.url.startsWith(baseUrl), `remote ${remote.type} must be absolute and same-origin`);
  }
  assert(manifest._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.publicRegistryPublishing === false, 'manifest must explicitly opt out of public registry publishing');
  walk(manifest);

  console.log(`MCP registry-readiness check passed for ${baseUrl}`);
})().catch((error) => {
  console.error(`MCP registry-readiness check failed: ${error.message}`);
  process.exit(1);
});
