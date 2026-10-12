#!/usr/bin/env node
/*
 * Entity-Scope-Check (Review-Fund C-9 / C-15, 2026-10-12).
 *
 * Das Muster war in sechs Services identisch: `findById()` prüfte den
 * Projekt-/Kunden-Scope, die Schreib- und Download-Pfade gingen direkt aufs
 * Modell. Am deutlichsten bei attachments — dieselbe Datei, benachbarte
 * Methoden:
 *
 *     findById(id)   :172-186  -> actorCanAccessProject/Customer, 403   ✓
 *     download(id)   :205-210  -> findById().select() -> MinIO          ✗
 *     getContent(id) :212-217  -> dito                                  ✗
 *     update(id,dto) :188+     -> findByIdAndUpdate                     ✗
 *
 * Die Metadaten waren geschützt, die DATEIBYTES nicht.
 *
 * Dieser Check belegt für alle sechs Services, dass ein verengter Actor fremde
 * Entitäten weder lesen, ändern noch löschen kann — und dass die Schreibpfade
 * die Prüfung VOR der Mutation ausführen (deshalb der Zähler).
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { RequestContext } = loadCompiled('common/request-context.js');
const { UserRole } = loadCompiled('auth/schemas/user.schema.js');
const { AttachmentsService } = loadCompiled('attachments/attachments.service.js');
const { SecretsService } = loadCompiled('secrets/secrets.service.js');
const { ProjectsService } = loadCompiled('projects/projects.service.js');
const { TodosService } = loadCompiled('todos/todos.service.js');
const { KnowledgeService } = loadCompiled('knowledge/knowledge.service.js');
const { CustomersService } = loadCompiled('customers/customers.service.js');
const mongoose = loadCompiled('../node_modules/mongoose/index.js');
const { Types } = mongoose;

const EXPECTED_CHECKS = 10;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const OWN_PROJECT = new Types.ObjectId();
const FOREIGN_PROJECT = new Types.ObjectId();
const OWN_CUSTOMER = new Types.ObjectId();
const FOREIGN_CUSTOMER = new Types.ObjectId();

/** Actor mit explizit verengtem Scope — die Konfiguration, um die es geht. */
function asScopedActor(allowedProjectIds, allowedCustomerIds, fn) {
  return RequestContext.run({
    userId: 'u-scoped', username: 'scoped', role: 'user',
    projectScopeMode: 'allowlist', allowedProjectIds,
    customerScopeMode: 'allowlist', allowedCustomerIds,
  }, undefined, fn);
}

/**
 * In-Memory-Modell mit den Ketten, die die Services benutzen
 * (`findById().select().exec()`, `findByIdAndUpdate().exec()`, …).
 * `counter` zählt Schreib- und Löschzugriffe: ein abgelehnter Aufruf darf nicht
 * nur werfen, er muss nachweislich NICHTS geändert haben — sonst wäre eine
 * Prüfung, die erst NACH der Mutation läuft, genauso grün.
 */
function makeModel(docs, counter) {
  const store = new Map();
  for (const d of docs) {
    const doc = {
      ...d,
      async save() { counter.writes += 1; },
      // Mongoose-Dokumente liefern toObject(); SecretsService.toListItem()
      // benutzt es. Ohne das wäre der Stub unvollständig, nicht der Code falsch.
      toObject() {
        const { save: _save, toObject: _toObject, ...rest } = this;
        return rest;
      },
    };
    store.set(String(d._id), doc);
  }
  const chain = (value) => ({
    select: () => chain(value),
    sort: () => chain(value),
    skip: () => chain(value),
    limit: () => chain(value),
    lean: () => chain(value),
    populate: () => chain(value),
    exec: async () => value,
  });
  const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.$in) {
      return v.$in.map(String).includes(String(doc[k]));
    }
    return String(doc[k]) === String(v);
  });
  return {
    _store: store,
    findById: (id) => chain(store.get(String(id)) ?? null),
    findOne: (f) => chain([...store.values()].find((d) => matches(d, f)) ?? null),
    find: (f) => chain([...store.values()].filter((d) => matches(d, f))),
    findByIdAndUpdate: (id, upd) => ({
      select: function sel() { return this; },
      exec: async () => {
        const doc = store.get(String(id));
        if (!doc) return null;
        counter.writes += 1;
        Object.assign(doc, upd && upd.$set ? upd.$set : upd);
        return doc;
      },
    }),
    findByIdAndDelete: (id) => ({
      exec: async () => {
        const doc = store.get(String(id));
        if (!doc) return null;
        counter.deletes += 1;
        store.delete(String(id));
        return doc;
      },
    }),
    deleteOne: (f) => ({
      exec: async () => {
        let n = 0;
        for (const key of [...store.keys()]) {
          if (matches(store.get(key), f)) { store.delete(key); n += 1; }
        }
        counter.deletes += n;
        return { deletedCount: n };
      },
    }),
    deleteMany: (f) => ({
      exec: async () => {
        let n = 0;
        for (const key of [...store.keys()]) {
          if (matches(store.get(key), f)) { store.delete(key); n += 1; }
        }
        counter.deletes += n;
        return { deletedCount: n };
      },
    }),
    async create(doc) { counter.writes += 1; const _id = doc._id || new Types.ObjectId(); const s = { _id, ...doc, async save() {} }; store.set(String(_id), s); return s; },
    countDocuments: () => ({ exec: async () => 0 }),
  };
}

const noopEmitter = { emit: () => {}, on: () => {} };
const counter = { writes: 0, deletes: 0 };
function reset() { counter.writes = 0; counter.deletes = 0; }

/** Baut alle sechs Services mit je einem eigenen und einem fremden Dokument. */
function buildServices() {
  const attachments = {
    _id: new Types.ObjectId(), projectId: OWN_PROJECT, storageKey: 'p/own_file.pdf',
    originalName: 'own.pdf', size: 10, mimeType: 'application/pdf', textContent: 'eigener Volltext',
  };
  const attachmentForeign = {
    _id: new Types.ObjectId(), projectId: FOREIGN_PROJECT, storageKey: 'p/foreign.pdf',
    originalName: 'foreign.pdf', size: 10, mimeType: 'application/pdf', textContent: 'FREMDER VOLLTEXT',
  };
  const attachmentModel = makeModel([attachments, attachmentForeign], counter);

  const secretOwn = {
    _id: new Types.ObjectId(), projectId: OWN_PROJECT, key: 'own', type: 'generic',
    encryptedValue: 'aa:bb:cc',
  };
  const secretForeign = {
    _id: new Types.ObjectId(), projectId: FOREIGN_PROJECT, key: 'ssh_private_key', type: 'ssh_key',
    encryptedValue: 'dd:ee:ff', ownedBySshConnectionId: new Types.ObjectId(),
  };
  const secretModel = makeModel([secretOwn, secretForeign], counter);

  const projectOwn = { _id: OWN_PROJECT, name: 'Eigenes Projekt' };
  const projectForeign = { _id: FOREIGN_PROJECT, name: 'Fremdes Projekt' };
  const projectModel = makeModel([projectOwn, projectForeign], counter);

  const todoOwn = { _id: new Types.ObjectId(), projectId: OWN_PROJECT, title: 'eigenes Todo', status: 'open' };
  const todoForeign = { _id: new Types.ObjectId(), projectId: FOREIGN_PROJECT, title: 'fremdes Todo', status: 'open' };
  const todoModel = makeModel([todoOwn, todoForeign], counter);

  const knowledgeOwn = { _id: new Types.ObjectId(), projectId: OWN_PROJECT, topic: 'eigen' };
  const knowledgeForeign = { _id: new Types.ObjectId(), projectId: FOREIGN_PROJECT, topic: 'fremd' };
  const knowledgeModel = makeModel([knowledgeOwn, knowledgeForeign], counter);

  const customerOwn = { _id: OWN_CUSTOMER, name: 'Eigener Kunde', status: 'active' };
  const customerForeign = { _id: FOREIGN_CUSTOMER, name: 'Fremder Kunde', status: 'active' };
  const customerModel = makeModel([customerOwn, customerForeign], counter);
  const linkModel = makeModel([], counter);

  const customersService = new CustomersService(customerModel, linkModel, todoModel, null, noopEmitter);
  const projectsService = new ProjectsService(projectModel, linkModel, noopEmitter, {});

  return {
    counter,
    ids: {
      attachmentOwn: String(attachments._id), attachmentForeign: String(attachmentForeign._id),
      secretOwn: String(secretOwn._id), secretForeign: String(secretForeign._id),
      projectOwn: String(OWN_PROJECT), projectForeign: String(FOREIGN_PROJECT),
      todoOwn: String(todoOwn._id), todoForeign: String(todoForeign._id),
      knowledgeOwn: String(knowledgeOwn._id), knowledgeForeign: String(knowledgeForeign._id),
      customerOwn: String(OWN_CUSTOMER), customerForeign: String(FOREIGN_CUSTOMER),
    },
    stores: { attachmentModel, secretModel, projectModel, todoModel, knowledgeModel, customerModel },
    attachments: new AttachmentsService(
      attachmentModel,
      { getObject: async () => ({ pipe: () => {} }), removeObject: async () => {} },
      customersService,
      noopEmitter,
    ),
    secrets: new SecretsService(
      secretModel, customersService,
      { isEnabled: () => true, encrypt: (v) => `enc:${v}`, decrypt: (v) => `dec:${v}` },
      noopEmitter,
    ),
    projects: projectsService,
    todos: new TodosService(
      todoModel, projectModel,
      { next: async () => 1 }, customersService, noopEmitter,
      { countOpenForTodo: async () => ({ count: 0, items: [] }) },
    ),
    knowledge: new KnowledgeService(knowledgeModel, customersService, noopEmitter),
    customers: customersService,
  };
}

/** Erwartet 403 und dass der Zähler unverändert bleibt. */
async function expectForbidden(label, fn) {
  const before = { ...counter };
  const err = await fn().then(() => null, (e) => e);
  assert.ok(err, `${label}: fremde Entität wurde NICHT abgelehnt`);
  assert.equal(typeof err.getStatus, 'function', `${label}: erwartet eine HttpException, bekam ${err}`);
  assert.equal(err.getStatus(), 403, `${label}: erwartet 403, bekam ${err.getStatus()}`);
  assert.deepEqual({ writes: counter.writes, deletes: counter.deletes }, before,
    `${label}: es wurde geschrieben/gelöscht — die Prüfung läuft NACH der Mutation`);
}

(async () => {
  await check('attachments: download/getContent/getText/update/remove verweigern fremde Anhänge', async () => {
    const fx = buildServices();
    await asScopedActor([String(OWN_PROJECT)], [], async () => {
      reset();
      await expectForbidden('download', () => fx.attachments.download(fx.ids.attachmentForeign));
      await expectForbidden('getContent', () => fx.attachments.getContent(fx.ids.attachmentForeign));
      await expectForbidden('getText', () => fx.attachments.getText(fx.ids.attachmentForeign));
      await expectForbidden('update', () => fx.attachments.update(fx.ids.attachmentForeign, { description: 'x' }));
      await expectForbidden('remove', () => fx.attachments.remove(fx.ids.attachmentForeign));
      // Der fremde Anhang muss noch da sein — inkl. seines MinIO-Objekts.
      assert.equal(fx.stores.attachmentModel._store.has(fx.ids.attachmentForeign), true,
        'der fremde Anhang wurde gelöscht');
    });
  });

  await check('attachments: eigene Anhänge bleiben vollständig erreichbar', async () => {
    const fx = buildServices();
    await asScopedActor([String(OWN_PROJECT)], [], async () => {
      const meta = await fx.attachments.findById(fx.ids.attachmentOwn);
      assert.equal(meta.originalName, 'own.pdf');
      const text = await fx.attachments.getText(fx.ids.attachmentOwn);
      assert.equal(text.text, 'eigener Volltext', 'getText() liefert den Volltext nicht mehr');
      const updated = await fx.attachments.update(fx.ids.attachmentOwn, { description: 'neu' });
      assert.equal(updated.description, 'neu');
      // Ein Scope, der alles sperrt, ist keiner.
      await fx.attachments.remove(fx.ids.attachmentOwn);
      assert.equal(fx.stores.attachmentModel._store.has(fx.ids.attachmentOwn), false,
        'der eigene Anhang wurde nicht gelöscht');
    });
  });

  await check('secrets: update/delete verweigern fremde Secrets', async () => {
    const fx = buildServices();
    await asScopedActor([String(OWN_PROJECT)], [], async () => {
      reset();
      // Der folgenreichste Fall: ein verengter Actor konnte den Wert JEDES
      // Secrets überschreiben, inkl. SSH-Private-Keys und Kubeconfigs
      // (ownedBySshConnectionId / ownedByKubeClusterId) — fremde Verbindungen
      // übernehmen, ohne den Klartext je zu sehen.
      await expectForbidden('secret.update', () => fx.secrets.update(fx.ids.secretForeign, { value: 'uebernommen' }));
      await expectForbidden('secret.delete', () => fx.secrets.delete(fx.ids.secretForeign));
      await expectForbidden('secret.findById', () => fx.secrets.findById(fx.ids.secretForeign));
      assert.equal(fx.stores.secretModel._store.has(fx.ids.secretForeign), true,
        'das fremde Secret wurde gelöscht');
      const foreign = fx.stores.secretModel._store.get(fx.ids.secretForeign);
      assert.equal(foreign.encryptedValue, 'dd:ee:ff', 'der fremde Secret-Wert wurde überschrieben');
    });
  });

  await check('secrets: eigene Secrets bleiben änder- und löschbar', async () => {
    const fx = buildServices();
    await asScopedActor([String(OWN_PROJECT)], [], async () => {
      const item = await fx.secrets.update(fx.ids.secretOwn, { description: 'neu' });
      assert.equal(item.description, 'neu');
      await fx.secrets.delete(fx.ids.secretOwn);
      assert.equal(fx.stores.secretModel._store.has(fx.ids.secretOwn), false);
    });
  });

  await check('projects: update/updateRaw/remove verweigern fremde Projekte', async () => {
    const fx = buildServices();
    await asScopedActor([String(OWN_PROJECT)], [], async () => {
      reset();
      await expectForbidden('project.update', () => fx.projects.update(fx.ids.projectForeign, { name: 'uebernommen' }));
      await expectForbidden('project.updateRaw', () => fx.projects.updateRaw(fx.ids.projectForeign, { name: 'roh' }));
      // remove() löst über PROJECT_CHANGED die removeByProject-Kaskade über 21
      // Services aus — der destruktivste Pfad der Anwendung.
      await expectForbidden('project.remove', () => fx.projects.remove(fx.ids.projectForeign));
      assert.equal(fx.stores.projectModel._store.has(fx.ids.projectForeign), true,
        'das fremde Projekt wurde gelöscht');
    });
  });

  await check('todos: update/remove/addComment verweigern fremde Todos', async () => {
    const fx = buildServices();
    await asScopedActor([String(OWN_PROJECT)], [], async () => {
      reset();
      await expectForbidden('todo.update', () => fx.todos.update(fx.ids.todoForeign, { title: 'uebernommen' }));
      await expectForbidden('todo.remove', () => fx.todos.remove(fx.ids.todoForeign));
      await expectForbidden('todo.addComment', () => fx.todos.addComment(fx.ids.todoForeign, 'fremder Kommentar'));
      assert.equal(fx.stores.todoModel._store.has(fx.ids.todoForeign), true);
    });
  });

  await check('knowledge: update/remove verweigern fremde Einträge', async () => {
    const fx = buildServices();
    await asScopedActor([String(OWN_PROJECT)], [], async () => {
      reset();
      await expectForbidden('knowledge.update', () => fx.knowledge.update(fx.ids.knowledgeForeign, { topic: 'x' }));
      await expectForbidden('knowledge.remove', () => fx.knowledge.remove(fx.ids.knowledgeForeign));
      assert.equal(fx.stores.knowledgeModel._store.has(fx.ids.knowledgeForeign), true);
    });
  });

  await check('customers: update/archive verweigern fremde Kunden', async () => {
    const fx = buildServices();
    await asScopedActor([], [String(OWN_CUSTOMER)], async () => {
      reset();
      await expectForbidden('customer.update', () => fx.customers.update(fx.ids.customerForeign, { name: 'x' }));
      await expectForbidden('customer.archive', () => fx.customers.archive(fx.ids.customerForeign));
      const foreign = fx.stores.customerModel._store.get(fx.ids.customerForeign);
      assert.notEqual(foreign.status, 'archived', 'der fremde Kunde wurde archiviert');
    });
  });

  await check('kein Actor (interner Aufrufer / Replikation) bleibt ungegated', async () => {
    const fx = buildServices();
    assert.equal(RequestContext.getUser(), undefined, 'Testannahme: kein Actor gesetzt');
    // Dokumentierte Konvention: ein fehlender Actor ist ein vertrauenswürdiger
    // interner Aufrufer. Ein fail-closed-Check würde Replikation, Migrationen
    // und den stdio-MCP-Transport ausschalten.
    const foreign = await fx.attachments.findById(fx.ids.attachmentForeign);
    assert.equal(foreign.originalName, 'foreign.pdf');
    await fx.projects.update(fx.ids.projectForeign, { name: 'intern' });
    await fx.todos.remove(fx.ids.todoForeign);
    await fx.secrets.delete(fx.ids.secretForeign);
  });

  await check('Admin-Rolle umgeht den Daten-Scope NICHT', async () => {
    const fx = buildServices();
    // permissions.ts dokumentiert das ausdrücklich: der Rollen-Bypass gilt nur
    // für actorHasPermission (Berechtigungen), nicht für den Daten-Scope. Ein
    // Admin mit bewusst verengtem API-Key will genau diese Verengung.
    await RequestContext.run({
      userId: 'u-admin', username: 'admin', role: UserRole.ADMIN,
      projectScopeMode: 'allowlist', allowedProjectIds: [String(OWN_PROJECT)],
      customerScopeMode: 'allowlist', allowedCustomerIds: [String(OWN_CUSTOMER)],
    }, undefined, async () => {
      reset();
      await expectForbidden('admin: project.remove', () => fx.projects.remove(fx.ids.projectForeign));
      await expectForbidden('admin: attachments.download', () => fx.attachments.download(fx.ids.attachmentForeign));
      await expectForbidden('admin: secrets.update', () => fx.secrets.update(fx.ids.secretForeign, { value: 'x' }));
    });
    // Ohne Verengung (Default 'all') bleibt der Admin uneingeschränkt.
    await RequestContext.run(
      { userId: 'a2', username: 'admin2', role: UserRole.ADMIN }, undefined,
      async () => {
        const doc = await fx.attachments.findById(fx.ids.attachmentForeign);
        assert.equal(doc.originalName, 'foreign.pdf');
      },
    );
  });

  console.log('');
  if (total !== EXPECTED_CHECKS) {
    console.error(
      `FEHLER: erwartet ${EXPECTED_CHECKS} Fälle, tatsächlich ${total} gelaufen — der Lauf wurde offenbar vorzeitig abgebrochen.`,
    );
    process.exit(1);
  }
  console.log(`Entity scope checks: ${total - failures}/${total} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
