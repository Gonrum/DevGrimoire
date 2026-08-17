#!/usr/bin/env node
/**
 * HarnessService — Ebenen-Auflösung und Section-Upserts (T-438, M-51/H1).
 *
 * Prüft die Service-Schicht gegen Attrappen der drei Modelle. Der Merge selbst
 * hat einen eigenen Check (`check:harness-resolve`); hier geht es um die Fragen,
 * die nur der Service beantworten kann:
 *
 *   - kommen die Ebenen in der Reihenfolge global → customer(s) → project an
 *   - in welcher Reihenfolge kommen mehrere Kunden
 *   - was passiert bei fehlenden Ebenen
 *   - ist `sectionSet` idempotent
 *
 * Läuft gegen `dist/`, ohne Nest und ohne MongoDB.
 */
const assert = require('node:assert');

const { HarnessService } = require('../dist/harness/harness.service');

let passed = 0;
function check(name, fn) {
  return fn()
    .then(() => {
      passed += 1;
      console.log(`✓ ${name}`);
    })
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(`  ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}

// --- Attrappen -------------------------------------------------------------

/** Minimale ObjectId-Attrappe: `toString()` ist alles, was der Service nutzt. */
function oid(hex) {
  return { toString: () => hex, _isOid: true };
}

function query(value) {
  const q = {
    sort: () => q,
    select: () => q,
    lean: () => q,
    exec: async () => value,
  };
  return q;
}

/**
 * Harness-Modell: hält Dokumente in einer Liste und wertet genau die Filter
 * aus, die der Service stellt (scope / projectId / customerId / _id +
 * sections.key).
 */
function harnessModel(docs = []) {
  const store = [...docs];
  const idOf = (v) => (v && typeof v === 'object' && v.toString ? v.toString() : String(v));

  function matches(doc, filter) {
    for (const [key, want] of Object.entries(filter)) {
      if (key === 'sections.key') {
        const keys = (doc.sections || []).map((s) => s.key);
        if (want && typeof want === 'object' && '$ne' in want) {
          if (keys.includes(want.$ne)) return false;
        } else if (!keys.includes(want)) {
          return false;
        }
        continue;
      }
      const have = doc[key];
      if (want && typeof want === 'object' && Array.isArray(want.$in)) {
        if (!want.$in.some((v) => idOf(v) === idOf(have))) return false;
        continue;
      }
      if (want && typeof want === 'object' && '$ne' in want) {
        if (idOf(have) === idOf(want.$ne)) return false;
        continue;
      }
      if (idOf(have) !== idOf(want)) return false;
    }
    return true;
  }

  const model = {
    calls: [],
    store,
    findOne(filter) {
      model.calls.push(filter);
      return query(store.find((d) => matches(d, filter)) || null);
    },
    find(filter) {
      return query(store.filter((d) => matches(d, filter)));
    },
    async create(data) {
      const doc = { _id: oid(`h${store.length + 1}`), sections: [], ...data };
      store.push(doc);
      return doc;
    },
    findOneAndUpdate(filter, update) {
      const doc = store.find((d) => matches(d, filter));
      if (!doc) return query(null);
      if (update.$set && update.$set['sections.$']) {
        const next = update.$set['sections.$'];
        const idx = doc.sections.findIndex((s) => s.key === next.key);
        doc.sections[idx] = next;
      }
      if (update.$push && update.$push.sections) doc.sections.push(update.$push.sections);
      if (update.$pull && update.$pull.sections) {
        doc.sections = doc.sections.filter((s) => s.key !== update.$pull.sections.key);
      }
      return query(doc);
    },
  };
  return model;
}

function linkModel(links = []) {
  return {
    find(filter) {
      const wanted = filter.projectId.$in.map((v) => String(v));
      const excluded = filter.status && filter.status.$ne;
      const out = links
        .filter((l) => wanted.includes(String(l.projectId)))
        .filter((l) => !excluded || l.status !== excluded)
        .sort((a, b) => a.createdAt - b.createdAt);
      return query(out);
    },
  };
}

function projectModel(exists = true) {
  return { findOne: () => query(exists ? { _id: oid('p1') } : null) };
}

const PROJECT = '69c12580c01a0739c142f1c0';

function section(key, body, extra = {}) {
  return {
    key,
    kind: 'prose',
    title: key,
    body,
    mergeStrategy: 'replace',
    order: 0,
    enabled: true,
    ...extra,
  };
}

// --- Prüfungen -------------------------------------------------------------

async function main() {
  await check('resolve() reicht global → customer → project in dieser Reihenfolge durch', async () => {
    const harnesses = harnessModel([
      { _id: oid('g'), scope: 'global', enabled: true, sections: [section('stil', 'global')] },
      {
        _id: oid('c'),
        scope: 'customer',
        customerId: oid('cust1'),
        enabled: true,
        sections: [section('stil', 'kunde')],
      },
      {
        _id: oid('p'),
        scope: 'project',
        projectId: oid(PROJECT),
        enabled: true,
        sections: [section('stil', 'projekt')],
      },
    ]);
    const svc = new HarnessService(
      harnesses,
      linkModel([{ projectId: oid(PROJECT), customerId: oid('cust1'), createdAt: 1, status: 'active' }]),
      projectModel(),
    );

    const res = await svc.resolve(PROJECT);
    assert.deepStrictEqual(
      res.resolvedFrom.map((l) => l.scope),
      ['global', 'customer', 'project'],
    );
    // `replace` auf jeder Ebene: die unterste gewinnt.
    assert.strictEqual(res.sections[0].body, 'projekt');
  });

  await check('mehrere Kunden werden nach Verlinkungs-createdAt aufsteigend gemergt', async () => {
    const harnesses = harnessModel([
      {
        _id: oid('cA'),
        scope: 'customer',
        customerId: oid('custA'),
        enabled: true,
        sections: [section('regeln', 'A', { mergeStrategy: 'append' })],
      },
      {
        _id: oid('cB'),
        scope: 'customer',
        customerId: oid('custB'),
        enabled: true,
        sections: [section('regeln', 'B', { mergeStrategy: 'append' })],
      },
    ]);
    // B wurde ZUERST verlinkt, A später — die Reihenfolge folgt der Verlinkung,
    // nicht der Reihenfolge im Harness-Store.
    const svc = new HarnessService(
      harnesses,
      linkModel([
        { projectId: oid(PROJECT), customerId: oid('custA'), createdAt: 20, status: 'active' },
        { projectId: oid(PROJECT), customerId: oid('custB'), createdAt: 10, status: 'active' },
      ]),
      projectModel(),
    );

    const res = await svc.resolve(PROJECT);
    assert.deepStrictEqual(
      res.resolvedFrom.map((l) => l.customerId),
      ['custB', 'custA'],
    );
    assert.strictEqual(res.sections[0].body, 'B\n\nA');
  });

  await check('resolvedFrom benennt die customerId jeder beteiligten Kundenebene', async () => {
    const svc = new HarnessService(
      harnessModel([
        {
          _id: oid('c'),
          scope: 'customer',
          customerId: oid('cust9'),
          enabled: true,
          sections: [section('a', 'x')],
        },
      ]),
      linkModel([{ projectId: oid(PROJECT), customerId: oid('cust9'), createdAt: 1, status: 'active' }]),
      projectModel(),
    );
    const res = await svc.resolve(PROJECT);
    assert.deepStrictEqual(res.resolvedFrom, [{ scope: 'customer', projectId: undefined, customerId: 'cust9' }]);
  });

  await check('fehlende Ebenen ergeben ein gültiges Ergebnis, keinen Fehler', async () => {
    const svc = new HarnessService(harnessModel([]), linkModel([]), projectModel());
    const res = await svc.resolve(PROJECT);
    assert.deepStrictEqual(res.sections, []);
    assert.deepStrictEqual(res.resolvedFrom, []);
    assert.strictEqual(res.markdown, '');
  });

  await check('verlinkter Kunde ohne Harness wird übersprungen, nicht als leere Ebene gemergt', async () => {
    const svc = new HarnessService(
      harnessModel([
        { _id: oid('g'), scope: 'global', enabled: true, sections: [section('a', 'global')] },
      ]),
      linkModel([{ projectId: oid(PROJECT), customerId: oid('ohne'), createdAt: 1, status: 'active' }]),
      projectModel(),
    );
    const res = await svc.resolve(PROJECT);
    assert.deepStrictEqual(
      res.resolvedFrom.map((l) => l.scope),
      ['global'],
    );
  });

  await check('archivierte Verlinkung trägt nicht bei', async () => {
    const svc = new HarnessService(
      harnessModel([
        {
          _id: oid('c'),
          scope: 'customer',
          customerId: oid('alt'),
          enabled: true,
          sections: [section('a', 'alt')],
        },
      ]),
      linkModel([{ projectId: oid(PROJECT), customerId: oid('alt'), createdAt: 1, status: 'archived' }]),
      projectModel(),
    );
    const res = await svc.resolve(PROJECT);
    assert.deepStrictEqual(res.resolvedFrom, []);
  });

  await check('pausierte Verlinkung trägt weiterhin bei', async () => {
    const svc = new HarnessService(
      harnessModel([
        {
          _id: oid('c'),
          scope: 'customer',
          customerId: oid('pause'),
          enabled: true,
          sections: [section('a', 'x')],
        },
      ]),
      linkModel([{ projectId: oid(PROJECT), customerId: oid('pause'), createdAt: 1, status: 'paused' }]),
      projectModel(),
    );
    const res = await svc.resolve(PROJECT);
    assert.deepStrictEqual(
      res.resolvedFrom.map((l) => l.scope),
      ['customer'],
    );
  });

  await check('Harness mit enabled:false wird als ganze Ebene übersprungen', async () => {
    const svc = new HarnessService(
      harnessModel([
        { _id: oid('g'), scope: 'global', enabled: true, sections: [section('a', 'global')] },
        {
          _id: oid('c'),
          scope: 'customer',
          customerId: oid('aus'),
          enabled: false,
          sections: [section('a', 'kunde')],
        },
      ]),
      linkModel([{ projectId: oid(PROJECT), customerId: oid('aus'), createdAt: 1, status: 'active' }]),
      projectModel(),
    );
    const res = await svc.resolve(PROJECT);
    assert.deepStrictEqual(
      res.resolvedFrom.map((l) => l.scope),
      ['global'],
    );
    assert.strictEqual(res.sections[0].body, 'global');
  });

  await check('resolve() auf unbekannte projectId wirft NotFound statt leerem Ergebnis', async () => {
    const svc = new HarnessService(harnessModel([]), linkModel([]), projectModel(false));
    await assert.rejects(() => svc.resolve(PROJECT), /not found/i);
  });

  await check('resolve() mit ungültiger projectId wirft BadRequest statt eines Cast-Fehlers', async () => {
    const svc = new HarnessService(harnessModel([]), linkModel([]), projectModel());
    await assert.rejects(() => svc.resolve('nicht-hex'), /not a valid project id/);
  });

  await check('mehrere Kundenebenen werden in EINER Abfrage geholt', async () => {
    const harnesses = harnessModel([
      { _id: oid('c1'), scope: 'customer', customerId: oid('c1'), enabled: true, sections: [section('a', '1')] },
      { _id: oid('c2'), scope: 'customer', customerId: oid('c2'), enabled: true, sections: [section('b', '2')] },
    ]);
    let finds = 0;
    const origFind = harnesses.find;
    harnesses.find = (filter) => {
      finds += 1;
      return origFind(filter);
    };
    const svc = new HarnessService(
      harnesses,
      linkModel([
        { projectId: oid(PROJECT), customerId: oid('c1'), createdAt: 1, status: 'active' },
        { projectId: oid(PROJECT), customerId: oid('c2'), createdAt: 2, status: 'active' },
      ]),
      projectModel(),
    );
    const res = await svc.resolve(PROJECT);
    assert.strictEqual(res.resolvedFrom.length, 2);
    assert.strictEqual(finds, 1, `zwei Kunden duerfen eine find()-Abfrage kosten, nicht ${finds}`);
  });

  await check('sectionSet ist idempotent — zweimal gleicher Input, gleicher Zustand', async () => {
    const harnesses = harnessModel([]);
    const svc = new HarnessService(harnesses, linkModel([]), projectModel());
    const dto = { key: 'stil', kind: 'prose', title: 'Stil', body: 'kurz', mergeStrategy: 'replace' };

    const first = await svc.sectionSet({ scope: 'global' }, dto);
    const snapshot = JSON.stringify(first.sections);
    const second = await svc.sectionSet({ scope: 'global' }, dto);

    assert.strictEqual(second.sections.length, 1, 'zweiter Aufruf darf keine zweite Section anlegen');
    assert.strictEqual(JSON.stringify(second.sections), snapshot);
    assert.strictEqual(harnesses.store.length, 1, 'es darf nur ein globaler Harness entstehen');
  });

  await check('sectionSet setzt die Defaults explizit — kein Feld fällt beim Ersetzen weg', async () => {
    const svc = new HarnessService(harnessModel([]), linkModel([]), projectModel());
    const doc = await svc.sectionSet({ scope: 'global' }, { key: 'nur-key', kind: 'prose' });
    const s = doc.sections[0];
    assert.deepStrictEqual(
      { title: s.title, body: s.body, mergeStrategy: s.mergeStrategy, order: s.order, enabled: s.enabled },
      { title: '', body: '', mergeStrategy: 'replace', order: 0, enabled: true },
    );
  });

  await check('sectionSet aktualisiert eine vorhandene Section, statt sie zu duplizieren', async () => {
    const svc = new HarnessService(harnessModel([]), linkModel([]), projectModel());
    await svc.sectionSet({ scope: 'global' }, { key: 'stil', kind: 'prose', body: 'alt' });
    const doc = await svc.sectionSet({ scope: 'global' }, { key: 'stil', kind: 'prose', body: 'neu' });
    assert.strictEqual(doc.sections.length, 1);
    assert.strictEqual(doc.sections[0].body, 'neu');
  });

  await check('sectionDelete entfernt gezielt; unbekannter Key wirft NotFound', async () => {
    const svc = new HarnessService(harnessModel([]), linkModel([]), projectModel());
    await svc.sectionSet({ scope: 'global' }, { key: 'a', kind: 'prose', body: '1' });
    await svc.sectionSet({ scope: 'global' }, { key: 'b', kind: 'prose', body: '2' });

    const doc = await svc.sectionDelete({ scope: 'global' }, 'a');
    assert.deepStrictEqual(doc.sections.map((s) => s.key), ['b']);
    await assert.rejects(() => svc.sectionDelete({ scope: 'global' }, 'a'), /not found/i);
  });

  await check('sectionSet ohne projectId bei scope project wird abgelehnt', async () => {
    const svc = new HarnessService(harnessModel([]), linkModel([]), projectModel());
    await assert.rejects(
      () => svc.sectionSet({ scope: 'project' }, { key: 'a', kind: 'prose' }),
      /projectId is required/,
    );
  });

  console.log(`\n${passed} Prüfungen bestanden.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
