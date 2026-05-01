# MCP Tools

DevGrimoire currently registers 126 MCP tools in `backend/src/mcp-tools.ts`.

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
| RAG | `rag_search`, `rag_reindex`, `rag_status` |
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
