# Living Documentation

Living Documentation keeps DevGrimoire lore, manuals, and project documentation from silently drifting away from the code and architecture. The system should detect likely stale documentation after meaningful changes and propose reviewable updates instead of rewriting knowledge automatically.

## Goals

- Detect documentation that may be affected by todos, commits, releases, architecture changes, API changes, setup changes, and security changes.
- Produce concrete, reviewable update proposals with rationale and suggested diffs or instructions.
- Keep the user in control: proposals can be accepted, edited, converted into todos, or dismissed.
- Support agents with structured signals while avoiding destructive automatic edits.
- Preserve sensitive boundaries: no secret values in proposals, logs, prompts, or generated diffs.

## Non-goals

- No automatic blind rewriting of manuals or knowledge entries.
- No requirement that every code change creates a proposal.
- No storage of raw secret values, credentials, or large source snapshots in proposal metadata.
- No public publishing of internal lore.

## Signals

Living Documentation should combine cheap deterministic signals first and semantic signals second.

### Deterministic signals

| Signal | Example | Candidate docs |
| --- | --- | --- |
| Changed file path | `backend/src/auth/**` | `docs/security.md`, API key docs |
| Todo tags | `security`, `mcp`, `workflow-canvas` | matching docs/knowledge tags |
| Todo title/body keywords | `API`, `MCP`, `Backup`, `Workflow` | docs with same domain terms |
| Commit message | `feat(workflows): add scheduler` | workflow docs, setup docs |
| Release/changelog category | `breaking`, `security`, `setup` | README, operations, security docs |
| Entity links | todo references milestone/project area | docs linked to same area |

### Semantic signals

- Knowledge/RAG similarity between change summary and docs/manuals.
- Knowledge graph edges from code modules to docs/manuals.
- Prior proposals: avoid repeatedly suggesting the same stale doc for unchanged context.

## DocUpdateProposal entity sketch

```ts
type DocUpdateProposalStatus =
  | 'open'
  | 'accepted'
  | 'edited'
  | 'converted_to_todo'
  | 'dismissed'
  | 'superseded';

interface DocUpdateProposal {
  _id: ObjectId;
  projectId: ObjectId;
  status: DocUpdateProposalStatus;
  source: {
    type: 'todo' | 'commit' | 'release' | 'workflow_run' | 'manual';
    id: string;
    title?: string;
    summary: string;
    changedFiles?: string[];
    tags?: string[];
  };
  target: {
    type: 'doc_file' | 'knowledge' | 'manual';
    id?: string;
    path?: string;
    title: string;
  };
  reason: string;
  confidence: number;
  suggestedChange: {
    mode: 'patch' | 'instructions' | 'new_section' | 'review_only';
    summary: string;
    diff?: string;
    instructions?: string;
  };
  safety: {
    containsSecretValues: false;
    requiresHumanReview: true;
    destructive: false;
  };
  createdBy: 'system' | 'agent' | 'user';
  createdAt: Date;
  updatedAt: Date;
}
```

## Detection pipeline

1. **Collect change summary**
   - Todo completion/review transition.
   - Commit or release ingest.
   - Workflow result with meaningful changed files or generated artifacts.
2. **Find candidates**
   - Path/tag/keyword mapping.
   - Existing knowledge links.
   - Optional RAG search over docs, manuals, and knowledge.
3. **Score candidates**
   - Higher score for explicit file/tag/domain matches.
   - Lower score for broad semantic-only matches.
   - Suppress duplicates if an open proposal already exists for the same source+target.
4. **Create proposal**
   - Store concise rationale and safe suggested change.
   - Prefer instructions when confidence is low.
   - Prefer patch/new_section only for high-confidence docs.
5. **Review UX**
   - Show proposal in project quality/docs panel and relevant target detail view.
   - Allow accept/edit/dismiss/convert-to-todo.
6. **Apply**
   - Applying a patch must still validate target version and show conflicts.
   - Accepted proposals write activity logs and provenance.

## Review states

- `open`: needs review.
- `accepted`: applied as proposed.
- `edited`: user modified before applying.
- `converted_to_todo`: follow-up work was created instead of direct edit.
- `dismissed`: user decided no update is needed.
- `superseded`: replaced by a newer proposal for the same source/target.

## UI sketch

Add a **Docs Health** section to the project quality/oracle area:

- Open proposal count.
- Filters by source type, status, target type, confidence.
- Proposal detail with:
  - source summary
  - target doc/manual link
  - reason and matched signals
  - suggested diff/instructions
  - action buttons: Apply, Edit, Convert to Todo, Dismiss

In the Todo done/review flow, show a warning such as:

> This change may affect `docs/security.md` and `README.md`. Review 2 documentation update proposals.

## Agent and workflow integration

- Workflow node: `Suggest documentation updates`.
- Chat/MCP read tools:
  - `doc_update_proposal_list`
  - `doc_update_proposal_get`
- Chat/MCP write tools, gated by allowlist and scopes:
  - `doc_update_proposal_create`
  - `doc_update_proposal_update_status`
  - `doc_update_proposal_convert_to_todo`
- Applying a diff should be a separate, explicitly allowed action; agents should default to creating proposals or todos.

## Safety rules

- Strip or mask secret-like values before proposal generation.
- Do not include raw API keys, JWTs, passwords, private tokens, or decrypted secret values.
- Do not auto-apply changes to docs/knowledge without user confirmation or an explicitly configured safe workflow.
- Proposal diffs are suggestions, not authority; target version must be checked before apply.
- Logs should include proposal IDs and target references, not full sensitive content.

## MVP heuristic

Start with a deterministic scoring function:

```ts
score = 0
+ 4 if changed file path maps to target doc domain
+ 3 if todo/release tags overlap target tags
+ 2 if title/body keywords overlap target title/headings
+ 2 if target was linked from same milestone/project area
+ 1 if semantic search returns target in top results
- 3 if an open proposal already exists for same source+target
```

Create proposals for candidates with score >= 5. Use `review_only` mode for score 5-6 and `instructions`/`patch` only for stronger matches.

## Acceptance mapping

- **Plausible affected manuals/knowledge entries:** deterministic mappings plus RAG/knowledge graph candidates.
- **Reviewable proposals, not destructive:** `DocUpdateProposal` stores safe suggestions and requires review.
- **UI shows open proposals:** Docs Health panel and done-flow warnings surface `open` proposals.
- **Agent can apply or create todos:** gated tools support status updates and conversion; direct apply remains explicitly permissioned.

## Implementation order

1. Add `DocUpdateProposal` schema/service and duplicate suppression.
2. Add deterministic candidate scoring for todo completion/review and commit ingest.
3. Add list/detail/update REST endpoints.
4. Add Docs Health UI list and proposal detail actions.
5. Add workflow node and read-only MCP tools.
6. Add optional RAG/knowledge graph enrichment once the semantic graph is available.

## Implemented slice (T-263 Slice A)

Vertikaler MVP-Schnitt — alle vier Akzeptanzkriterien erfüllt, Follow-ups bewusst ausgeklammert.

### Backend

- `DocUpdateProposal` Mongoose-Schema mit nested source/target/suggestedChange/safety. Indexe für `(projectId, status, createdAt)`, `(projectId, source.type, source.id)`, `(projectId, target.type, target.id)`.
- `DocUpdateProposalsService` mit:
  - `create(dto)` mit Duplikat-Suppression: gibt bestehenden offenen Proposal mit gleichem source+target zurück statt neuen anzulegen.
  - `list/findById/updateStatus/convertToTodo/removeByProject`.
  - `updateStatus` validiert erlaubte Transitionen: `open → accepted/edited/converted_to_todo/dismissed/superseded`, `accepted ↔ edited`, `dismissed → open`.
  - `convertToTodo` idempotent über `metadata.todoId`, fällt zurück auf Neuanlage wenn Ziel-Todo gelöscht.
  - `@OnEvent(PROJECT_CHANGED)`-Listener: triggert `detectForTodo` bei Todo-Status-Übergängen nach `review` oder `done` und räumt bei Project-Delete auf.
- `detectForTodo`: deterministisches Scoring gegen Manuals und Knowledge im selben Projekt:
  - Manuals: +3 Titel-Keyword-Overlap, +2 Kategorie matcht Todo-Tag. Threshold ≥ 3.
  - Knowledge: +3 Tag-Overlap, +2 Titel-Keyword-Overlap, +1 Kategorie matcht Todo-Tag. Threshold ≥ 3.
  - Stopwords + Mindestlänge 4 für Token-Overlap; Top-5-Kandidaten werden persistiert; `mode` ist `instructions` ab Score ≥ 7, sonst `review_only`.
- REST: `POST/GET /api/doc-update-proposals`, `POST /api/doc-update-proposals/:id/status`, `POST /api/doc-update-proposals/:id/convert-to-todo`, `POST /api/doc-update-proposals/detect/todo/:todoId`.
- MCP-Tools (Task-Management-Gruppe): `doc_update_proposal_list/get/create/update_status/convert_to_todo`.

### Frontend

- `DocsHealthList` in ProjectDetail-Tab `docs-health` (neuer Tab in Knowledge-Gruppe mit Open-Count-Badge). Filter nach Status/Source/Target, Buttons für Accept/Convert/Dismiss.
- `TodoDocProposalsBanner` in TodoDetail bei Status `review`/`done`: zeigt offene Doc-Update-Vorschläge zu diesem Todo mit Link auf den Docs-Health-Tab.
- SSE-Events `doc-update-proposal` updaten den Count im Nav-Item live.

### Bewusst ausgeklammert (Follow-ups)

- Commit-Ingest-Trigger und File-Path-Mapping → erfordert Commit-Modul-Integration.
- RAG-/Wissensgraph-Enrichment → wartet auf T-261.
- Workflow-Node `Suggest documentation updates` → kann ergänzt werden sobald der Detection-Service stabil ist.
- Apply-Diff-Aktion mit Versions-Check → derzeit nur `accept`-Status, kein automatisches Schreiben.
- Doc-File-Ziele (`target.type === 'doc_file'`) sind im Schema vorhanden, werden aber vom Detector nicht erzeugt — nur Manuals und Knowledge.
