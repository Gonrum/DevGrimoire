#!/usr/bin/env node
/*
 * Regression check for schema documents in RAG.
 *
 * Safety: this creates one temporary schema fixture and removes only that
 * fixture when the check finishes. Set DG_RAG_SCHEMA_CHECK_CONFIRM=1 to run.
 */
const { Client } = require('../node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StdioClientTransport } = require('../node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');

const CONFIRM = process.env.DG_RAG_SCHEMA_CHECK_CONFIRM === '1';
const PROJECT_NAME = process.env.DG_RAG_SCHEMA_PROJECT || 'DevGrimoire';
const CLEANUP = process.env.DG_RAG_SCHEMA_CHECK_CLEANUP !== 'false';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function parseToolText(result) {
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) return null;
  return JSON.parse(text);
}

async function main() {
  if (!CONFIRM) {
    console.error('Refusing to run without DG_RAG_SCHEMA_CHECK_CONFIRM=1.');
    console.error('The check creates a temporary schema fixture, runs rag_reindex, searches it, and cleans it up by default.');
    process.exit(2);
  }

  const transport = new StdioClientTransport({
    command: 'docker',
    args: ['exec', '-i', 'devgrimoire-backend', 'node', 'dist/mcp-server'],
    cwd: require('path').resolve(__dirname, '..', '..'),
  });
  const client = new Client({ name: 'rag-schema-regression-check', version: '1.0.0' });
  await client.connect(transport);

  const call = async (name, args = {}) => parseToolText(await client.callTool({ name, arguments: args }));
  let fixtureId;
  const marker = `rag_schema_regression_${Date.now()}`;

  try {
    const projects = await call('project_list', { name: PROJECT_NAME });
    const project = projects.find((p) => p.name === PROJECT_NAME);
    if (!project) throw new Error(`Project ${PROJECT_NAME} not found`);

    const fixture = await call('schema_create', {
      projectId: project._id,
      name: marker,
      dbType: 'mongodb',
      database: 'devgrimoire_regression',
      description: `Temporary RAG schema regression fixture for ${marker}. Covers GDPR retention policy descriptions.`,
      fields: [
        {
          name: 'customerPermissionMatrix',
          type: 'object',
          nullable: false,
          description: `Permission matrix field searchable by RAG for ${marker}`,
          isIndexed: true,
        },
        {
          name: 'schemaSearchSentinel',
          type: 'string',
          description: 'Unique schema regression search sentinel',
        },
      ],
      indexes: [
        {
          name: 'idx_customer_permission_matrix',
          fields: ['customerPermissionMatrix'],
          type: 'btree',
        },
      ],
      tags: ['rag-regression', 'schema'],
    });
    fixtureId = fixture._id;

    console.log(`Created schema fixture ${fixtureId} (${marker})`);
    await call('rag_reindex', { projectId: project._id });

    const checks = [
      { label: 'collection/name', query: marker },
      { label: 'field name', query: 'customerPermissionMatrix' },
      { label: 'description', query: 'GDPR retention policy descriptions' },
      { label: 'index name', query: 'idx_customer_permission_matrix' },
    ];

    for (const check of checks) {
      const results = await call('rag_search', { projectId: project._id, entity: 'schema', query: check.query, limit: 5 });
      const hit = results.find((result) => result.id === fixtureId && result.entity === 'schema');
      if (!hit) fail(`Missing schema RAG hit for ${check.label}: ${check.query}`);
      else console.log(`✓ ${check.label}: ${hit.title} (${hit.score.toFixed(3)})`);
    }

    const updated = await call('schema_update', {
      id: fixtureId,
      fields: [
        {
          name: 'schemaSearchMutationSentinel',
          type: 'string',
          description: `Updated-field regression sentinel for ${marker}`,
          isIndexed: true,
        },
      ],
      changeNote: 'RAG schema regression update path check',
    });
    if (!updated?.updated) throw new Error('schema_update did not report updated=true');
    await call('rag_reindex', { projectId: project._id });
    const updateResults = await call('rag_search', {
      projectId: project._id,
      entity: 'schema',
      query: 'schemaSearchMutationSentinel',
      limit: 5,
    });
    if (!updateResults.find((result) => result.id === fixtureId && result.entity === 'schema')) {
      fail('Missing schema RAG hit after update + reindex');
    } else {
      console.log('✓ update + reindex path');
    }

    if (CLEANUP) {
      await call('schema_delete', { id: fixtureId });
      fixtureId = undefined;
      await call('rag_reindex', { projectId: project._id });
      const deleteResults = await call('rag_search', { projectId: project._id, entity: 'schema', query: marker, limit: 5 });
      if (deleteResults.some((result) => result.title === marker)) fail('Schema fixture still appears after cleanup + reindex');
      else console.log('✓ cleanup + reindex path');
    } else {
      console.log('Cleanup disabled; fixture left in place for manual inspection.');
    }
  } finally {
    if (fixtureId && CLEANUP) {
      // Aufräumen im finally: schlägt das Löschen fehl (Fixture schon weg,
      // Verbindung tot), darf das den eigentlichen Prüfbefund nicht überdecken.
      try { await call('schema_delete', { id: fixtureId }); } catch { /* egal */ }
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
