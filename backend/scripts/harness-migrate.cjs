#!/usr/bin/env node
/**
 * Migration: Soul + `project.instructions` + `agent_instructions` → Harness
 * (T-442, M-51/H1).
 *
 * Idempotent: ein zweiter Lauf schreibt nichts. Die Entscheidung, was zu tun
 * ist, trifft `planHarnessMigration()` in `dist/harness/harness-migrate.js` —
 * eine reine Funktion mit eigenem Unit-Check (`check:harness-migrate`). Dieses
 * Skript liest, schreibt und berichtet; es entscheidet nichts.
 *
 * Die Soul-Collection bleibt **unangetastet**. Entfernt wird erst, wenn die
 * Migration auf beiden Instanzen bestätigt ist — sonst steht die Replikation
 * bei einem Rollback vor einer verschwundenen Collection.
 *
 * Aufruf:
 *   node scripts/harness-migrate.cjs            # schreibt
 *   node scripts/harness-migrate.cjs --dry-run  # zeigt nur den Plan
 *
 * MONGODB_URI kommt aus der Umgebung bzw. der `.env` im Projekt-Root.
 */
const path = require('node:path');
const fs = require('node:fs');
const mongoose = require('mongoose');

const { planHarnessMigration, summarisePlan } = require('../dist/harness/harness-migrate');

const DRY_RUN = process.argv.includes('--dry-run');
const AGENT_INSTRUCTIONS_KEY = 'agent_instructions';

function loadEnv() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  for (const candidate of [
    path.join(__dirname, '..', '..', '.env'),
    path.join(__dirname, '..', '.env'),
  ]) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, 'utf-8').split('\n')) {
      const m = /^MONGODB_URI=(.*)$/.exec(line.trim());
      if (m) return m[1];
    }
  }
  throw new Error('MONGODB_URI not set and not found in .env');
}

async function main() {
  const uri = loadEnv();
  await mongoose.connect(uri, { directConnection: true });
  const db = mongoose.connection.db;

  const souls = await db.collection('souls').find({}).toArray();
  const projects = await db
    .collection('projects')
    .find({ instructions: { $exists: true, $ne: '' } })
    .project({ _id: 1, instructions: 1 })
    .toArray();
  const setting = await db.collection('settings').findOne({ key: AGENT_INSTRUCTIONS_KEY });
  const harnesses = await db.collection('harnesses').find({}).toArray();

  const plan = planHarnessMigration({
    souls: souls.map((s) => ({
      projectId: s.projectId ? String(s.projectId) : undefined,
      customerId: s.customerId ? String(s.customerId) : undefined,
      fields: s,
    })),
    projects: projects.map((p) => ({ id: String(p._id), instructions: p.instructions })),
    agentInstructions: setting ? setting.value : undefined,
    existing: harnesses.map((h) => ({
      scope: h.scope,
      projectId: h.projectId ? String(h.projectId) : undefined,
      customerId: h.customerId ? String(h.customerId) : undefined,
      sectionKeys: (h.sections || []).map((sec) => sec.key),
    })),
  });

  const summary = summarisePlan(plan);
  console.log('Gelesen:');
  console.log(`  Souls                : ${souls.length}`);
  console.log(`  Projekte mit instructions: ${projects.length}`);
  console.log(`  agent_instructions   : ${setting ? String(setting.value).length + ' Zeichen' : 'nicht gesetzt'}`);
  console.log(`  vorhandene Harnesses : ${harnesses.length}`);
  console.log('');
  console.log('Plan:');
  console.log(`  Ebenen zu schreiben  : ${summary.levels}`);
  console.log(`  Sections zu schreiben: ${summary.sections}`);
  console.log(`  übersprungen (leer)  : ${summary.skippedEmpty}`);
  console.log(`  übersprungen (existiert bereits): ${summary.skippedExisting}`);

  if (DRY_RUN) {
    console.log('\n--dry-run: nichts geschrieben.');
    for (const level of plan.levels) {
      const owner = level.projectId || level.customerId || '-';
      console.log(`  ${level.scope} ${owner}: ${level.sections.map((s) => s.key).join(', ')}`);
    }
    await mongoose.disconnect();
    return;
  }

  let created = 0;
  let written = 0;

  for (const level of plan.levels) {
    const filter = { scope: level.scope };
    if (level.projectId) filter.projectId = new mongoose.Types.ObjectId(level.projectId);
    if (level.customerId) filter.customerId = new mongoose.Types.ObjectId(level.customerId);

    const existing = await db.collection('harnesses').findOne(filter);
    if (!existing) {
      const now = new Date();
      await db.collection('harnesses').insertOne({
        ...filter,
        description: 'Aus Soul / project.instructions / agent_instructions migriert (T-442)',
        enabled: true,
        sections: level.sections.map((s) => ({ ...s, enabled: true })),
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      created += 1;
      written += level.sections.length;
      continue;
    }

    // `$push` statt Dokument-Replace: eine parallel entstandene Section darf
    // nicht verlorengehen. Die Keys sind laut Plan noch nicht vorhanden.
    await db.collection('harnesses').updateOne(filter, {
      $push: { sections: { $each: level.sections.map((s) => ({ ...s, enabled: true })) } },
      $set: { updatedAt: new Date() },
    });
    written += level.sections.length;
  }

  console.log('');
  console.log('Geschrieben:');
  console.log(`  Harnesses neu angelegt: ${created}`);
  console.log(`  Sections geschrieben  : ${written}`);
  console.log(`  Soul-Collection       : unverändert (${souls.length} Dokumente)`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
