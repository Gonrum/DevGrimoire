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
