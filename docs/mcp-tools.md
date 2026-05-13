# MCP Tools

DevGrimoire currently registers 126 MCP tools in `backend/src/mcp-tools.ts`.

For future interactive MCP Apps/UI resources, follow the [MCP Apps Security and Audit Model](mcp-apps-security.md) before exposing any `ui://` resource or tool `_meta.ui` linkage.

The README and in-app Docs should be treated as summaries. When changing tools, update or regenerate all three places together:

- `backend/src/mcp-tools.ts`
- `README.md`
- `frontend/src/pages/Docs.tsx`

## Tool Groups

| Area | Examples |
| --- | --- |
| Projects | `project_create`, `project_list`, `project_get`, `project_update`, `project_delete` |
| Todos | `todo_create`, `todo_list`, `todo_get`, `todo_update`, `todo_delete`, `todo_comment` |
| Milestones | `milestone_create`, `milestone_list`, `milestone_get`, `milestone_update`, `milestone_delete` |
| Knowledge, Research, Manuals | `knowledge_*`, `research_*`, `manual_*` |
| Schemas, Dependencies, Features, Snippets | `schema_*`, `dependency_*`, `feature_*`, `snippet_*` |
| Releases, Logs, Attachments, Commits | `release_*`, `log_*`, `attachment_*`, `commit_*` |
| RAG | `rag_search` (entity filter includes `schema`), `rag_reindex`, `rag_status` |
| Web Search | `web_search`, `web_fetch` |
| Workspaces | `workspace_create`, `workspace_clone`, `workspace_read`, `workspace_search`, `workspace_exec`, `workspace_attachment_save` |
| Chat | `chat_create`, `chat_list`, `chat_get`, `chat_send`, `chat_delete` |
| Dialog/System | `notify_user`, `ask_user`, `system_instructions_get`, `system_instructions_set` |

## Maintenance Check

To verify the documented count:

```bash
rg -n "^\\s+name: '" backend/src/mcp-tools.ts | wc -l
```

If this number changes, update the README feature list, the README MCP heading, and the in-app `Docs.tsx` MCP section.

## RAG Schema Regression Check

Schema documents are indexed by RAG as the `schema` entity, including schema names, descriptions, fields, and indexes. A reproducible check lives in `backend/scripts/rag-schema-regression-check.cjs` and is exposed as:

```bash
cd backend
DG_RAG_SCHEMA_CHECK_CONFIRM=1 npm run check:rag-schema
```

The check creates one temporary schema fixture in the DevGrimoire project, runs `rag_reindex`, verifies `rag_search` hits for collection/name, field name, description, and index name, then updates the fixture and verifies the updated field after another reindex. By default it deletes only the fixture it created and reindexes again to verify cleanup. Set `DG_RAG_SCHEMA_CHECK_CLEANUP=false` to leave the fixture for manual inspection.

The script exercises the reindex path. Incremental created/updated/deleted sync is still covered by the application `PROJECT_CHANGED` event path in `RagService`; run the backend normally (not stdio MCP mode) when manually checking that path.
