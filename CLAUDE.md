# ClaudeVault

MCP Server + REST API + React Frontend für Projekt-Wissensmanagement.

## Architektur
- **Backend**: NestJS + Mongoose + MongoDB (`backend/`)
- **Frontend**: React + Vite + TailwindCSS (`frontend/`)
- **MCP Server**: `@modelcontextprotocol/sdk` Server (`backend/src/mcp-server.ts`)
- **Infrastruktur**: Docker Compose (MongoDB als Replica Set, Backend, Frontend/nginx)

## Arbeitsweise
1. Immer Code Review vor jedem Commit durchführen
2. Lint-Prüfung vor jedem Commit ausführen
3. Wenn beides erfolgreich ist, pushen
4. Nach Code-Änderungen immer `docker compose up -d --build backend frontend` ausführen

## Task-Workflow (ClaudeVault Todos)
Wenn du Tasks in ClaudeVault bearbeitest:
1. Status auf `in_progress` setzen wenn du anfängst
2. Implementierung durchführen
3. Status auf `review` setzen
4. **Echte Code-Review durchführen** bevor du auf `done` setzt:
   - Lies den geänderten Code nochmal durch
   - Prüfe auf: fehlende Edge Cases, TypeScript-Fehler, kaputte Imports, Tailwind-Klassen die nicht funktionieren (dynamische Werte), fehlende Validierung, Security-Probleme
   - Dokumentiere gefundene Probleme und fixe sie
   - Schreibe die Review-Ergebnisse als Kommentar an den Task
   - Erst wenn alles sauber ist → `done`
5. Tasks NICHT einfach durch die Status-Stufen durchschieben — jeder Status muss eine echte Aktion widerspiegeln

## Build Notes
- Node snap version braucht `NODE_OPTIONS="--max-old-space-size=8192"` für tsc
- Backend Dockerfile setzt `--max-old-space-size=4096`
- Ports 3000 und 3001 sind auf diesem System belegt
- MongoDB läuft als Single-Node Replica Set (für Change Streams)
- MCP Server URI braucht `directConnection=true`

## MCP System Instructions
Rufe **immer** `system_instructions_get` am Anfang jeder Session auf, um die aktuellen Instruktionen zu laden.

### Session-Start
1. `system_instructions_get` aufrufen (optional mit `projectId`)
2. Projekt-Kontext laden via `project_get`
3. Letzte Session laden via `session_get`

### Projekte (`project_*`)
- Projekte sind der Container für alle Daten. Jede Entität gehört zu einem Projekt.
- `project_list` liefert nur Metadaten — für Instruktionen immer `project_get`
- `project_delete` löscht **alle** zugehörigen Daten (Todos, Sessions, Knowledge, Changelog, Milestones, Environments, Secrets, Research, Schemas, Dependencies, Manual)

### Todos (`todo_*`)
- Status-State-Machine: `open` → `in_progress` → `review` → `done` (nur ein Schritt!)
- Review-Ergebnisse als Kommentar (`todo_comment`) dokumentieren bevor auf "done"
- `todo_list` zeigt keine Content-Felder — für Beschreibung/Kommentare → `todo_get`
- Lookup über `id` ODER `number`+`projectId` (z.B. "T-3")
- Erledigte Tasks **archivieren** statt löschen

### Milestones (`milestone_*`)
- Gruppieren verwandte Todos. Status: `open` → `in_progress` → `done`
- **Abschluss erfordert Changelog**: Erst `changelog_add`, dann `milestone_update` mit `changelogId`
- Lookup über `id` ODER `number`+`projectId` (z.B. "M-1")

### Sessions (`session_*`)
- Am Ende jeder Arbeitssitzung speichern: `summary`, `filesChanged`, `nextSteps`, `openQuestions`

### Wissensdatenbank (`knowledge_*`)
- Langfristiges Projektwissen: Architektur, Patterns, Konventionen, Entscheidungen
- Content unterstützt **Markdown** inkl. Tabellen (GFM)
- Vor dem Anlegen `knowledge_search` nutzen um Duplikate zu vermeiden

### Changelog (`changelog_*`)
- Bei **jedem Fix, Feature oder Refactoring** einen Eintrag erstellen
- Format: `"feat: ..."`, `"fix: ..."`, `"refactor: ..."`, `"docs: ..."`, `"style: ..."`, `"perf: ..."`
- Wird für Milestone-Abschluss benötigt

### Recherche (`research_*`)
- Zeitpunktbezogene Recherchen mit Quellen (URLs/Referenzen)
- Unterschied zu Knowledge: Research = Recherche mit Quellen, Knowledge = langfristige Fakten

### Handbuch (`manual_*`)
- Mehrere kategorisierte Einträge pro Projekt (CRUD: `manual_create/list/get/update/delete`)
- Kategorien für Gruppierung (z.B. "Setup", "API", "Deployment"), `sortOrder` für Reihenfolge
- `manual_list` kompakt (ohne Content), `manual_get` für vollständigen Eintrag

### Schema-Objekte (`schema_*`)
- DB-Tabellen/Collections dokumentieren mit automatischer Versionierung
- `schema_update` erstellt automatisch Versions-Snapshot mit `changeNote`
- Fields: name, type, nullable, defaultValue, description, isPrimaryKey, isIndexed, reference
- Indexes: name, fields[], unique, type

### Dependencies (`dependency_*`)
- Paketabhängigkeiten (npm, composer, pip, cargo, go, maven, nuget, gem) pro Projekt
- `dependency_scan` für Bulk-Import aus Paketdateien (Upsert: neue anlegen, bestehende aktualisieren)
- Bestehende description/category/tags werden beim Scan nicht überschrieben

### Umgebungen (`environment_*`) & Secrets (`secret_*`)
- Umgebungen: Key-Value-Variablen pro Environment (dev/staging/prod)
- Secrets: AES-256-GCM verschlüsselt, Werte nie in Listen
- `environment_export` kombiniert Variablen + entschlüsselte Secrets

### Benachrichtigungen (`notify_user`)
- Push an ClaudeVault PWA: `title`, `body`, optional `url` (Deep-Link)

### System-Instruktionen (`system_instructions_*`)
- `system_instructions_get` am Start jeder Session aufrufen
- `system_instructions_set` nur auf Benutzer-Anfrage

### Context-Effizienz
- **List-Tools** liefern kompakte Übersichten (nur Metadaten)
- **_get Tools** nur wenn Details gebraucht werden
- **limit/offset** bei großen Listen nutzen
- **Search-Tools** liefern 200-Zeichen-Snippets, nicht den vollen Text
