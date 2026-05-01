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

## Restore

Restore MongoDB before starting the backend. If restoring to a new instance, keep `SECRETS_ENCRYPTION_KEY` unchanged so encrypted secrets, chat API keys, and replication credentials stay decryptable.

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
