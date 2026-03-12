export const AGENT_INSTRUCTIONS_KEY = 'agent_instructions';

export const DEFAULT_AGENT_INSTRUCTIONS = `# ClaudeVault Agent-Instruktionen

## Session-Start
Rufe **immer** \`system_instructions_get\` am Anfang jeder Session auf, um die aktuellen Instruktionen zu laden. Übergib optional eine \`projectId\`, um projektspezifische Anweisungen zu erhalten.

---

## 1. Projekte verwalten (\`project_*\`)

**Workflow**: Projekte sind der Container für alle Daten. Jede Entität gehört zu einem Projekt.

| Tool | Wann verwenden |
|------|----------------|
| \`project_create\` | Neues Projekt anlegen (Name, Pfad, techStack, Repo, Komponenten, Instruktionen) |
| \`project_list\` | Übersicht aller Projekte (kompakt). Für Details → \`project_get\` |
| \`project_get\` | Vollständige Projektdaten inkl. Instruktionen und Komponenten laden. Lookup über \`id\` oder \`name\` |
| \`project_update\` | Projekt aktualisieren (Name, Pfad, Beschreibung, techStack, aktiv-Status, Instruktionen, Komponenten) |
| \`project_delete\` | Projekt und **alle** zugehörigen Daten löschen (Todos, Sessions, Knowledge, Changelog, Milestones, Environments, Secrets, Research, Schemas, Dependencies, Features, Manual) |

**Tipps**:
- Nutze \`instructions\` um projektspezifische Agent-Anweisungen zu hinterlegen
- \`components\` für Monorepos mit separater Versionierung (z.B. API v1.2, Frontend v2.0)
- \`project_list\` liefert nur Metadaten — für Instruktionen immer \`project_get\` verwenden

---

## 2. Todos / Tasks (\`todo_*\`)

**Workflow**: Status-State-Machine mit strikter Reihenfolge: \`open\` → \`in_progress\` → \`review\` → \`done\`

1. **open → in_progress**: Wenn du mit der Arbeit beginnst
2. **in_progress → review**: Wenn die Implementierung fertig ist
3. **review → done**: Erst nach **echter Code-Review** — prüfe auf Fehler, Edge Cases, Security
4. Sprünge (z.B. open → done) werden **abgelehnt**. Immer nur einen Schritt vor oder zurück.
5. Review-Ergebnisse als **Kommentar** (\`todo_comment\`) dokumentieren bevor auf "done" gesetzt wird.

| Tool | Wann verwenden |
|------|----------------|
| \`todo_create\` | Neuen Task anlegen. Pflicht: \`projectId\`, \`title\`. Optional: Beschreibung, Status, Priorität, Tags, \`milestoneId\`, \`blockedBy\` (Abhängigkeiten) |
| \`todo_list\` | Kompakte Liste (id, title, status, priority, tags, milestoneId). Archivierte sind standardmäßig ausgeblendet. Filter: status, priority, milestoneId, tag. Pagination: limit/offset |
| \`todo_get\` | Volle Details inkl. Beschreibung, Kommentare, blockedBy. Lookup über \`id\` ODER \`number\`+\`projectId\` (z.B. "T-3") |
| \`todo_update\` | Status, Titel, Beschreibung, Priorität, Tags, Milestone, Abhängigkeiten, Archivierung ändern. Lookup über \`id\` ODER \`number\`+\`projectId\` |
| \`todo_delete\` | Task löschen. Lookup über \`id\` ODER \`number\`+\`projectId\` |
| \`todo_comment\` | Kommentar an Task anhängen (Fortschritt, Entscheidungen, Review-Ergebnisse). Lookup über \`id\` ODER \`number\`+\`projectId\` |

**Tipps**:
- Nutze \`blockedBy\` um Abhängigkeiten zwischen Tasks zu definieren
- Erledigte Tasks **archivieren** statt löschen (\`archived: true\`)
- \`todo_list\` zeigt keine Content-Felder — für Beschreibung/Kommentare → \`todo_get\`

---

## 3. Milestones (\`milestone_*\`)

**Workflow**: Milestones gruppieren verwandte Todos. Status: \`open\` → \`in_progress\` → \`done\`. Abschluss **erfordert** einen Changelog-Eintrag.

**Abschluss-Workflow (done)**:
1. Erstelle einen Changelog-Eintrag via \`changelog_add\`
2. Setze den Milestone auf \`done\` mit der \`changelogId\`
3. Ohne \`changelogId\` wird der Status auf "done" **abgelehnt**

| Tool | Wann verwenden |
|------|----------------|
| \`milestone_create\` | Neuen Milestone anlegen (Name, Beschreibung, Fälligkeitsdatum) |
| \`milestone_list\` | Alle Milestones eines Projekts. Archivierte standardmäßig ausgeblendet. Filter: status, includeArchived |
| \`milestone_get\` | Milestone-Details. Lookup über \`id\` ODER \`number\`+\`projectId\` (z.B. "M-1") |
| \`milestone_update\` | Status, Name, Beschreibung, Fälligkeitsdatum, Archivierung ändern. **changelogId Pflicht bei status=done** |
| \`milestone_delete\` | Milestone löschen. Lookup über \`id\` ODER \`number\`+\`projectId\` |

**Tipps**:
- Jeden Changelog nur **einmal** einem Milestone zuordnen — doppelte Verwendung wird abgelehnt
- Erledigte Milestones **archivieren** statt löschen

---

## 4. Sessions (\`session_*\`)

**Workflow**: Am Ende jeder Arbeitssitzung eine Session-Zusammenfassung speichern.

| Tool | Wann verwenden |
|------|----------------|
| \`session_save\` | Sitzung dokumentieren: Was wurde gemacht (\`summary\`), welche Dateien geändert (\`filesChanged\`), nächste Schritte (\`nextSteps\`), offene Fragen (\`openQuestions\`) |
| \`session_get\` | Letzte Session(s) laden um Kontext wiederherzustellen. Default: 1, einstellbar via \`limit\` |

**Wann speichern**:
- Am Ende jeder Arbeitssitzung
- Bei größeren Kontextwechseln
- Vor Übergabe an einen anderen Agent

---

## 5. Wissensdatenbank (\`knowledge_*\`)

**Workflow**: Langfristiges Projektwissen dokumentieren — Architektur, Patterns, Konventionen, Entscheidungen.

| Tool | Wann verwenden |
|------|----------------|
| \`knowledge_save\` | Neue Erkenntnis speichern. Pflicht: \`projectId\`, \`topic\`, \`content\`. Optional: \`tags\`, \`category\` (z.B. Architecture, Patterns, Conventions) |
| \`knowledge_list\` | Kompakte Übersicht (id, topic, tags, category). Filter: category. Pagination: limit/offset |
| \`knowledge_search\` | Volltextsuche über Wissenseinträge. Liefert Snippets (200 Zeichen) — für vollen Content → \`knowledge_get\` |
| \`knowledge_get\` | Vollständigen Wissenseintrag laden |
| \`knowledge_update\` | Eintrag aktualisieren (Topic, Content, Tags, Category) |
| \`knowledge_delete\` | Eintrag löschen |

**Wann speichern**:
- Architekturentscheidungen und deren Begründung
- Wiederkehrende Patterns und Konventionen
- Wichtige Konfiguration oder Infrastruktur-Details
- Erkenntnisse die sessions-übergreifend relevant sind

**Tipps**:
- Content unterstützt **Markdown** inkl. Tabellen (GFM)
- Vergib aussagekräftige \`category\` und \`tags\` für bessere Auffindbarkeit
- Vor dem Anlegen \`knowledge_search\` nutzen um Duplikate zu vermeiden

---

## 6. Changelog (\`changelog_*\`)

**Workflow**: Bei **jedem Fix, Feature oder Refactoring** einen Changelog-Eintrag erstellen.

| Tool | Wann verwenden |
|------|----------------|
| \`changelog_add\` | Neuen Eintrag anlegen. Pflicht: \`projectId\`, \`changes\` (Array). Optional: \`version\`, \`summary\`, \`component\` (für Monorepos) |
| \`changelog_list\` | Kompakte Liste (id, version, summary, component, date). Default Limit: 10. Pagination: limit/offset |
| \`changelog_get\` | Vollständigen Eintrag mit allen Changes laden |
| \`changelog_update\` | Eintrag aktualisieren (version, changes, summary, component) |
| \`changelog_delete\` | Eintrag löschen |

**Format der Changes**:
- \`"feat: ..."\` — Neues Feature
- \`"fix: ..."\` — Bugfix
- \`"refactor: ..."\` — Refactoring
- \`"docs: ..."\` — Dokumentation
- \`"style: ..."\` — UI/Styling
- \`"perf: ..."\` — Performance

**Tipps**:
- Auch bei kleinen Bugfixes einen Eintrag anlegen
- \`component\` für Monorepos verwenden (z.B. "Backend", "Frontend", "API")
- Changelog wird für Milestone-Abschluss benötigt

---

## 7. Recherche (\`research_*\`)

**Workflow**: Recherche-Ergebnisse mit Quellen dokumentieren — Evaluierungen, Vergleiche, Analysen.

| Tool | Wann verwenden |
|------|----------------|
| \`research_save\` | Recherche speichern. Pflicht: \`projectId\`, \`title\`, \`content\`. Optional: \`sources\` (URLs/Referenzen), \`tags\` |
| \`research_list\` | Kompakte Liste (id, title, tags, sourceCount). Pagination: limit/offset |
| \`research_search\` | Volltextsuche über Recherche-Einträge. Liefert Snippets — für vollen Content → \`research_get\` |
| \`research_get\` | Vollständigen Recherche-Eintrag laden |
| \`research_update\` | Eintrag aktualisieren |
| \`research_delete\` | Eintrag löschen |

**Wann verwenden**:
- Technologie-Evaluierungen (z.B. "Framework X vs Y")
- API-Dokumentation oder Integrationsanalysen
- Befunde aus Code-Analysen
- Externe Recherchen die zum Projekt gehören

**Unterschied zu Knowledge**: Research = zeitpunktbezogene Recherche mit Quellen. Knowledge = langfristige Fakten und Konventionen.

---

## 8. Handbuch (\`manual_*\`)

**Workflow**: Ein einzelnes Markdown-Dokument pro Projekt als Benutzerhandbuch.

| Tool | Wann verwenden |
|------|----------------|
| \`manual_save\` | Handbuch erstellen oder aktualisieren. Pflicht: \`projectId\`, \`content\` (Markdown). Optional: \`title\` |
| \`manual_get\` | Aktuelles Handbuch laden |

**Tipps**:
- Es gibt **ein** Handbuch pro Projekt (upsert-Verhalten)
- Content als vollständiges Markdown-Dokument übergeben (nicht inkrementell)
- Für Benutzer-Dokumentation, Setup-Anleitungen, FAQ etc.

---

## 9. Schema-Objekte (\`schema_*\`)

**Workflow**: Datenbank-Tabellen/Collections dokumentieren mit automatischer Versionierung bei Änderungen.

| Tool | Wann verwenden |
|------|----------------|
| \`schema_create\` | Schema anlegen. Pflicht: \`projectId\`, \`name\`, \`dbType\` (mssql/mysql/mongodb/postgresql). Optional: \`database\`, \`description\`, \`fields\`, \`indexes\`, \`tags\` |
| \`schema_list\` | Kompakte Liste (ohne fields/indexes). Filter: dbType, tags. Pagination: limit/offset |
| \`schema_get\` | Vollständiges Schema mit allen Fields und Indexes laden |
| \`schema_update\` | Schema aktualisieren. **Erstellt automatisch einen Versions-Snapshot** mit der \`changeNote\`. Version wird auto-inkrementiert |
| \`schema_delete\` | Schema und **alle Versionen** löschen |
| \`schema_versions\` | Versionshistorie eines Schemas. Optional: spezifische \`version\` laden |

**Field-Definition**:
- \`name\`, \`type\` (Pflicht)
- \`nullable\`, \`defaultValue\`, \`description\`, \`isPrimaryKey\`, \`isIndexed\`, \`reference\` (optional)
- \`reference\` für Foreign Keys: z.B. \`"users._id"\`

**Index-Definition**:
- \`name\`, \`fields[]\` (Pflicht)
- \`unique\`, \`type\` (optional, z.B. btree, hash, text, TTL, partial)

**Wann verwenden**:
- Neue Tabelle/Collection dokumentieren
- Bestehende Schemas aktualisieren (mit changeNote für Nachvollziehbarkeit)
- Schema-Versionen vergleichen um Änderungen nachzuvollziehen

---

## 10. Umgebungen (\`environment_*\`)

**Workflow**: Projekt-Umgebungen (dev/staging/prod) mit Verbindungsinfos und Variablen verwalten.

| Tool | Wann verwenden |
|------|----------------|
| \`environment_create\` | Umgebung anlegen (Name, Variablen als Key-Value-Paare, aktiv-Status) |
| \`environment_list\` | Alle Umgebungen eines Projekts auflisten |
| \`environment_get\` | Einzelne Umgebung mit allen Variablen laden |
| \`environment_update\` | Umgebung aktualisieren (Name, Variablen, aktiv-Status) |
| \`environment_delete\` | Umgebung löschen |
| \`environment_export\` | Alle Variablen + entschlüsselte Secrets als key=value exportieren (für .env Generierung). Optional: \`includeGlobalSecrets\` |

---

## 11. Secrets (\`secret_*\`)

**Workflow**: Verschlüsselte Secrets (AES-256-GCM) pro Projekt/Umgebung verwalten. **Werte werden nie in Listen angezeigt**.

| Tool | Wann verwenden |
|------|----------------|
| \`secret_set\` | Secret anlegen oder aktualisieren. Pflicht: \`projectId\`, \`key\`, \`value\`. Optional: \`environmentId\` (ohne = projekt-global), \`description\` |
| \`secret_list\` | Keys und Beschreibungen auflisten (**ohne Werte**). Filter: \`environmentId\` |
| \`secret_get\` | Einzelnes Secret mit **entschlüsseltem Wert** laden |
| \`secret_delete\` | Secret löschen |

**Tipps**:
- \`secret_set\` ist ein Upsert — überschreibt bei gleichem Key/Environment
- Ohne \`environmentId\` ist das Secret projekt-global (in allen Umgebungen verfügbar)
- \`environment_export\` kombiniert Variablen + Secrets für .env-Generierung

---

## 12. Benachrichtigungen (\`notify_user\`)

**Workflow**: Push-Benachrichtigung an den Benutzer über die ClaudeVault PWA senden.

| Tool | Wann verwenden |
|------|----------------|
| \`notify_user\` | Benutzer informieren. Pflicht: \`title\`, \`body\`. Optional: \`url\` (Deep-Link, z.B. \`/projects/abc123\`) |

**Wann verwenden**:
- Aufgabe erledigt
- Wichtiges Update oder Entdeckung
- Rückfrage an den Benutzer
- Fehler der Aufmerksamkeit erfordert

---

## 13. System-Instruktionen (\`system_instructions_*\`)

| Tool | Wann verwenden |
|------|----------------|
| \`system_instructions_get\` | **Am Start jeder Session aufrufen**. Lädt globale + optionale projekt-spezifische Instruktionen |
| \`system_instructions_set\` | Globale Agent-Instruktionen aktualisieren (nur auf Benutzer-Anfrage) |

---

## 14. Abhängigkeiten (\`dependency_*\`)

**Workflow**: Paketabhängigkeiten pro Projekt verwalten. Unterstützt 8 Paketmanager: npm, composer, pip, cargo, go, maven, nuget, gem.

| Tool | Wann verwenden |
|------|----------------|
| \`dependency_add\` | Einzelne Abhängigkeit anlegen. Pflicht: \`projectId\`, \`name\`, \`version\`, \`packageManager\`. Optional: \`description\`, \`devDependency\`, \`category\`, \`tags\` |
| \`dependency_list\` | Kompakte Liste (name, version, packageManager, devDependency, category). Filter: packageManager, category, devDependency. Pagination: limit/offset |
| \`dependency_get\` | Vollständige Details einer Abhängigkeit inkl. Beschreibung laden |
| \`dependency_update\` | Abhängigkeit aktualisieren (Version, Beschreibung, Kategorie, Tags) |
| \`dependency_delete\` | Abhängigkeit endgültig löschen |
| \`dependency_scan\` | **Bulk-Import** aus Paketdateien (package.json, composer.json etc.). Upsert: neue anlegen, bestehende Version aktualisieren. Bestehende description/category/tags bleiben erhalten |

**Tipps**:
- Unique Constraint: projectId + name + packageManager
- \`dependency_scan\` für initiale Erfassung, \`dependency_add\` für einzelne Pakete
- Vergib \`category\` (z.B. Database, Auth, UI, Testing) für bessere Übersicht

---

## 15. Feature-Katalog (\`feature_*\`)

**Workflow**: Features/Funktionen pro Projekt dokumentieren und deren Status verfolgen.

| Tool | Wann verwenden |
|------|----------------|
| \`feature_create\` | Feature anlegen. Pflicht: \`projectId\`, \`name\`. Optional: \`description\`, \`category\`, \`status\` (planned/in_development/released/deprecated), \`version\`, \`priority\` (low/medium/high), \`tags\` |
| \`feature_list\` | Kompakte Liste. Filter: status, category. Pagination: limit/offset |
| \`feature_get\` | Vollständige Feature-Details laden |
| \`feature_update\` | Feature aktualisieren (Name, Status, Beschreibung, Kategorie, Version, Priorität, Tags) |
| \`feature_delete\` | Feature endgültig löschen |

**Tipps**:
- Status-Verlauf: \`planned\` → \`in_development\` → \`released\` (kein strikter Workflow)
- \`deprecated\` für veraltete Features
- \`version\` für die Release-Version verwenden (z.B. "1.2.0")
- \`category\` für Feature-Gruppierung (z.B. "Auth", "Dashboard", "API")

---

## Effizient mit Context umgehen
- **List-Tools** liefern kompakte Übersichten (nur Metadaten, kein Content)
- Nutze **_get Tools** (todo_get, knowledge_get, changelog_get, research_get, schema_get, dependency_get, feature_get) nur wenn du Details brauchst
- Arbeite immer mit **projectId** — nie global suchen wenn du das Projekt kennst
- Nutze **limit/offset** bei großen Listen
- **Search-Tools** (knowledge_search, research_search) liefern Content-Snippets (200 Zeichen), nicht den vollen Text

## Code-Qualität
- Führe vor jedem Commit eine Lint-Prüfung durch
- Erstelle immer Code-Reviews bevor Tasks auf "done" gesetzt werden
- Teste Änderungen bevor du sie als fertig markierst
- Dokumentiere Review-Ergebnisse als Kommentar am Task
`;
