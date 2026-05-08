# Operations

## Volumes

The default Compose stack uses named volumes:

| Volume | Purpose |
| --- | --- |
| `mongodb_data` | MongoDB database |
| `mongodb_keyfile` | MongoDB replica-set keyfile |
| `lancedb_data` | RAG vector index |
| `workspace_data` | Workspace sidecar clones and scratch data |
| `minio_data` | Optional MinIO file storage, when enabled |

## Backup

At minimum, back up MongoDB and any enabled file-storage volume.

For Docker deployments, a practical baseline is:

- MongoDB logical dump with `mongodump`
- `lancedb_data` if rebuilding embeddings is expensive
- `workspace_data` only if active workspaces must survive restores
- MinIO bucket/volume if attachments are enabled

DevGrimoire also ships an application-level backup service for admin users:

- `POST /api/backups` creates a manual database or full-system backup in MinIO/S3.
- `BACKUP_DAILY_ENABLED` and `BACKUP_CRON` control the scheduled full-system backup (default: daily at 06:00 server time).
- `BACKUP_RETENTION_KEEP_LAST` and `BACKUP_RETENTION_KEEP_DAYS` define retention. Defaults keep the latest 14 completed backups and protect backups from the last 30 days.
- `GET /api/backups/retention/preview` is a dry-run and lists affected jobs/objects without deleting anything.
- `POST /api/backups/retention/apply` executes retention only when the request body contains `confirm: "DELETE_EXPIRED_BACKUPS"`.

## Restore

Restore MongoDB before starting the backend. If restoring to a new instance, keep `SECRETS_ENCRYPTION_KEY` unchanged so encrypted secrets, chat API keys, and replication credentials stay decryptable.

Use `GET /api/backups/:id/restore-preview` before any restore. It reads the stored manifest from MinIO and verifies every listed artifact by size and SHA-256 without modifying MongoDB or attachments. Actual restore execution is intentionally not automated; perform it only during a maintenance window after explicit operator confirmation.

## Updates

After pulling code changes:

```bash
docker compose up -d --build backend frontend workspace
```

If dependencies or Compose services changed, rebuild the full stack:

```bash
docker compose up -d --build
```

## RAG Reindex

Run `rag_reindex` after changing embedding models. Embeddings from different models are not compatible.
