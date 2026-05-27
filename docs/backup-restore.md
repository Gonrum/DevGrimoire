# Backup & Restore — Disaster-Recovery-Runbook

DevGrimoire schreibt Backups in einen MinIO/S3-Bucket. Die Backup-UI deckt das Anlegen, Listen, Retention-Management und einen Restore-**Preview** ab. Einen Klick-Restore aus der UI gibt es bewusst nicht — Restore ist ein Operations-Vorgang, der hier dokumentiert ist.

## Was wird gesichert

`backend/src/backups/backups.service.ts` schreibt pro Backup-Job folgende Artefakte in den Bucket (`BACKUP_BUCKET` env, default = `MINIO_BUCKET` + `-backups`) unter einem Zeitstempel-Prefix:

| Artefakt | Pfad | Inhalt |
|---|---|---|
| Datenbank-Dump | `<prefix>/mongodb.json.gz` | Alle Collections außer `system.*` als JSON-Dump, gzipped. Format-Marker: `devgrimoire.system-backup.database.v1` |
| Attachments-Manifest | `<prefix>/attachments-manifest.json.gz` | Liste aller Objekte aus dem MinIO-`MINIO_BUCKET` mit `sourceKey/backupKey/size/etag` |
| Attachment-Kopien | `<prefix>/attachments/<sourceKey>` | Eine MinIO-`copyObject`-Kopie pro Anhang aus dem Live-Bucket. Nur im `full-system`-Mode (Default). |
| Job-Manifest | `<prefix>/manifest.json` | Job-Metadaten: jobId, mode, app-Version, includes, alle Artefakt-Keys + sha256/size pro Datei |

Die Datenbank enthält verschlüsselte Secrets (AES-256-GCM via `SECRETS_ENCRYPTION_KEY`). Ohne den passenden Key sind die Secret-Werte beim Restore nicht entschlüsselbar — **Key zwingend mitsichern**, getrennt vom Backup.

Mode `database` (statt `full-system`) lässt die Attachment-Kopien weg. Sinnvoll für tägliche Mini-Backups, wenn MinIO ohnehin separat versioniert/repliziert.

## Restore aus einem MinIO-Backup (Worst-Case, kein UI)

Voraussetzungen:
- Zugang zum Backup-MinIO/S3 (lese: `mc`, `aws s3 cp`, oder beliebiger S3-Client)
- Eine leere oder leerbare MongoDB-Instanz (Replica Set wegen Change-Streams)
- Den `SECRETS_ENCRYPTION_KEY` der **ursprünglichen** Instanz
- Optional: Zielsystem-MinIO für die Attachments

### Schritte

1. **Backup identifizieren** — letzten erfolgreichen Job im Bucket finden. Entweder über `<bucket>/latest.json` (Pointer auf den jüngsten `objectPrefix`) oder per Datums-Prefix.

   ```bash
   mc cat myminio/devgrimoire-backups/latest.json
   ```

2. **Manifest validieren** — sha256/size jedes Artefakts gegen das Manifest abgleichen:

   ```bash
   mc cp myminio/devgrimoire-backups/<prefix>/manifest.json /tmp/manifest.json
   jq '.artifacts[]' /tmp/manifest.json
   # für jedes artifact:
   mc cat myminio/devgrimoire-backups/<artifact.key> | sha256sum
   ```

3. **Datenbank-Dump laden**:

   ```bash
   mc cp myminio/devgrimoire-backups/<prefix>/mongodb.json.gz /tmp/mongodb.json.gz
   gunzip /tmp/mongodb.json.gz
   # /tmp/mongodb.json hat die Form { format, exportedAt, collections: { <name>: [docs...] } }
   ```

4. **In Mongo restoren** — Single-Node Replica Set vorausgesetzt. Für jede Collection im Dump:

   ```bash
   jq -c '.collections | to_entries[] | .key as $c | .value[] | { collection: $c, doc: . }' /tmp/mongodb.json |
   while IFS= read -r line; do
     coll=$(echo "$line" | jq -r '.collection')
     doc=$(echo "$line" | jq -c '.doc')
     echo "$doc" | mongoimport --uri "$MONGODB_URI" --collection "$coll" --upsertFields _id --upsert
   done
   ```

   Schneller (parallel pro Collection): die Dump-Datei aufsplitten und `mongoimport` per Collection laufen lassen. Achtung: Index-Definitionen werden vom Dump **nicht** mitgeführt — sie entstehen beim ersten Backend-Boot automatisch via Mongoose-Schemata.

5. **Attachments wiederherstellen** (nur bei `full-system`-Backup):

   ```bash
   mc cp --recursive myminio/devgrimoire-backups/<prefix>/attachments/ myminio/devgrimoire/
   ```

   Das spiegelt jeden Object-Key 1:1 zurück in den Live-Bucket. Die Datenbank-Referenzen (`Attachment.objectKey`) bleiben gültig.

6. **Backend starten** mit identischem `SECRETS_ENCRYPTION_KEY`. Mongoose legt fehlende Indizes an, Change-Streams beginnen wieder zu schreiben.

7. **Verifizieren**: `/api/health`, in der UI eine Sicht auf Todos / Knowledge öffnen, Secret entschlüsseln testen (`environment_export` über MCP oder UI).

## Backup testen (Trockenlauf)

Bevor du im Ernstfall den Worst-Case-Restore auf der Prod-Instanz fährst, einmal in einer wegwerfbaren DevGrimoire-Instanz proben:

1. Frische Docker-Compose-Instanz aufsetzen (`docker compose up -d` in einem leeren Workdir, eigener Mongo-Volume, eigener MinIO).
2. `SECRETS_ENCRYPTION_KEY` und `BACKUP_BUCKET`-Env auf die Werte der Prod-Instanz setzen.
3. MinIO-Backup-Bucket aus Prod in den Test-MinIO spiegeln (`mc mirror`).
4. Schritte 1-7 oben durchlaufen.
5. Resultat sichten: Projekte, Todos, Workspaces, Anhänge da? Secrets entschlüsselbar?

Mindestens einmal pro Quartal durchspielen. Backup-API kennt einen `GET /api/backups/:id/restore-preview`, der Bucket-Erreichbarkeit + Artefakt-Hashes verifiziert, **ohne** etwas zu importieren — sinnvoll als wöchentlicher automatisierter Check (siehe T-359 in M-40).

## Replication-Failover

DevGrimoire kann zwischen Instanzen replizieren (`master` ↔ `slave` einseitig, `peer` ↔ `peer` bidirektional). Wenn der Master/Peer tot ist:

### Slave → Master promoten

```bash
curl -X POST http://<slave-host>/api/replication/promote \
  -H "Authorization: Bearer cv_<admin-api-key>"
```

Endpoint ist auf slave-Rolle beschränkt (`Only a slave can be promoted`). Setzt `REPL_ROLE=master`. Anschließend in der UI unter Einstellungen → Spiegelung den `slaveUrl` für die nächste Slave-Instanz konfigurieren.

### Peer-Pair: tote Peer-Seite

Peers sind symmetrisch. Wenn eine Seite stirbt:

- Die überlebende Seite läuft weiter (read+write), schreibt aber in ihre lokale Push-Queue für die tote Gegenseite. Queue-Cap = 5000 Events vor Overflow-Warnung; danach ist ein Full-Sync nötig.
- Sobald die zweite Seite wieder hochkommt: Pull-Cron fängt den Delta-Backlog auf (oder einmalig `POST /api/replication/sync/trigger`).
- Bei langer Downtime: lieber Full-Sync, weil LWW-Konflikt-Resolution sonst auf veraltete updatedAt-Felder hereinfallen kann.

Voraussetzung in jedem Failover-Szenario:
- Identischer `SECRETS_ENCRYPTION_KEY` auf beiden Seiten (sonst sind alle Secrets im Replikat unbrauchbar).
- NTP-synchron (sonst LWW willkürlich).
- Echo-Prevention via `sourceInstanceId` — jede Instanz hat eine UUID in den Settings; bei kompletter Neuinstallation kommt eine neue UUID, was die alte Echo-Erkennung neutralisiert.

## Eskalation bei `failed`-Backups

Fehlgeschlagene Backups schreiben:
- `BackupJob.status='failed'` + `error` in der DB
- `backup_failed` Push-Notification (Default in `DEFAULT_PUSH_CATEGORIES`)
- Audit-Log-Eintrag

Bei Hintergrund-Failures (Cron statt manuell) ist der Push-Pfad oft der einzige Trigger, der bemerkt wird. Wenn der Bucket vorübergehend nicht erreichbar war: nächster Cron-Lauf läuft normal weiter.

Wenn drei Backups in Folge failen:

1. `/api/backups?limit=10` öffnen, `error`-Felder lesen
2. MinIO-Erreichbarkeit prüfen: `mc ls myminio/<backup-bucket>` (oft Permissions oder Disk-Voll)
3. Bei Disk-Voll auf MinIO: Retention auslösen — `POST /api/backups/retention/apply` mit `confirm: "yes"`. Default-Policy steht in `BackupRetentionPolicy`-Settings.
4. Wenn weiterhin failed: System-Logs `docker compose logs backend | grep -i backup` für den Stacktrace.

Wenn die Live-MinIO selbst tot ist, sind die hier dokumentierten Restore-Schritte natürlich nicht ausführbar — daher: Backup-Bucket **getrennt** vom Anhangs-Bucket halten, idealerweise auf einem anderen Storage-System (separater MinIO, AWS S3, etc.).
