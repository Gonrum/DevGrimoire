# RecurringTasks ↔ Workflows: Koexistenz und Migration

Der Workflow-Canvas (M-31) und das ältere RecurringTask-Modul leben bewusst parallel.
Dieses Dokument beschreibt, wofür welches Modul gedacht ist, wie ein User vom einen
ins andere wechselt, und welche API-/Datenkompatibilität dabei gilt.

## Stand heute

- **RecurringTasks** (`backend/src/recurring-tasks`): zeitgesteuerte einfache Aufgaben.
  Frequenz, Wochentag/Tag-im-Monat, eine fixe Stunde. Bei Auslösung
  - erzeugt der Scheduler entweder eine Quest (`action: 'todo'`, Default), oder
  - ruft den Workflow-Agent mit einem konfigurierten Prompt auf und persistiert
    das Ergebnis als Chat-Session (`action: 'chat'`, T-265).
- **Workflows** (`backend/src/workflows`): voller visueller Graph mit beliebigen
  Trigger-, Aktions-, Control- und Agent-Nodes. Schedule-Trigger via Cron oder
  Intervall, Run-Historie pro Definition, Replay/Retry mit Child-Runs (T-254),
  Audit-Trail und Approval-Gate (T-256).

Beide Module schreiben in MongoDB, beide reagieren auf den Scheduler-Tick,
beide laufen ohne Konflikt nebeneinander — sie nutzen unterschiedliche Tabellen
und Cron-Pfade.

## Entscheidungsbaum: RecurringTask oder Workflow?

| Anforderung                                                | RecurringTask | Workflow |
| ---------------------------------------------------------- | :-----------: | :------: |
| "Einmal am 1. eines Monats eine Quest anlegen"             |       ✓       |    ✓     |
| "Jeden Montag früh eine Standard-Notification raushauen"   |       ✓       |    ✓     |
| "Agent analysiert wöchentlich die Todos"                   |       ✓ (chat) |    ✓     |
| Mehrere Aktionen hintereinander mit Bedingungen / Branches |       —       |    ✓     |
| User-Rückfragen mitten in der Ausführung                   |       —       |    ✓     |
| Verzögerungen (`delay.wait`) zwischen Schritten            |       —       |    ✓     |
| Replay/Retry mit Child-Runs und Diagnostik                 |       —       |    ✓     |
| Versionierter Approval-Trail pro Aktivierung               |       —       |    ✓     |

**Faustregel:** Linearer "Trigger → eine Aktion"-Fluss → RecurringTask reicht.
Sobald Verzweigung, Wartepunkte, oder mehrere koordinierte Schritte ins Spiel
kommen, lohnt sich der Wechsel auf einen Workflow.

## Mapping: RecurringTask → Workflow

Ein bestehendes RecurringTask lässt sich direkt auf einen äquivalenten Workflow
abbilden. Die Tabelle zeigt das Schema-Mapping; die Umsetzung als
Migrations-Endpoint ist optional und in M-31 nicht verbindlich enthalten.

| RecurringTask                       | Workflow-Definition                                             |
| ----------------------------------- | --------------------------------------------------------------- |
| `projectId` / `customerId`          | `scope` + `projectId` / `customerId`                            |
| `frequency` + `dayOfWeek/Month`     | `trigger.schedule` mit Cron (siehe Cron-Mapping unten)          |
| `hour`                              | Cron-Stunde                                                     |
| `title`                             | `name`                                                          |
| `description`                       | Description am Node, nicht an der Definition                    |
| `tags`                              | `tags`                                                          |
| `action: 'todo'` (Projekt/Customer) | `action.todo-create` Node mit `title`/`priority`/`tags` aus DTO |
| `action: 'todo'` (system-scope)     | `action.notify` Node                                            |
| `action: 'chat'`                    | `agent.task` Node mit `prompt`/`allowedTools`                   |
| `maxCatchUp`                        | Kein direktes Pendant; Workflows haben keinen Backfill-Counter  |

### Cron-Mapping

| Frequenz                         | Cron-Ausdruck     |
| -------------------------------- | ----------------- |
| `daily` `hour=9`                 | `0 9 * * *`       |
| `weekly` `dayOfWeek=1` `hour=9`  | `0 9 * * 1`       |
| `monthly` `dayOfMonth=1` `hour=9`| `0 9 1 * *`       |
| `yearly` `month=1`/`dayOfMonth=1`| `0 9 1 1 *`       |
| `biweekly`                       | Kein Cron — Workflows haben dafür noch kein Idiom; ggf. zwei wöchentliche Workflows oder ein `intervalMinutes: 20160`. |
| `quarterly`                      | `0 9 1 */3 *`     |

## Was passiert mit bestehenden RecurringTasks?

- Existieren weiter, laufen weiter. Keine automatische Migration.
- Bestehende API/MCP-Tools (`recurring_task_create/list/get/update/delete`)
  bleiben stabil. Neue Felder (`action`, `chat`, `lastRunStatus`,
  `chatSessionIds`, `createdByUserId`) sind alle optional bzw. haben Defaults.
- Replikation: Replicated-Felder behalten ihre Semantik. Neue Felder
  replizieren mit, wenn die Instanz die neue Version fährt.

## Wann lohnt sich ein expliziter Migrationspfad?

Aktuell nicht. Begründung:

- Beide Module decken ihre Nische sauber ab. Workflows sind reichhaltiger, aber
  jedes "Erzeuge wöchentlich eine Quest" als Graph zu modellieren wäre
  Overkill.
- Workflow-Aktivierung verlangt einen Approval-Trail und Policy-Check
  (T-256). Das passt zu Automationen mit Tool-/Agent-Zugriff, nicht zu
  Einzeilen-Notifications.
- Die UX in RecurringTaskCreatePage ist optimiert auf "Häufigkeit + Wochentag",
  was als Cron-Selector im Canvas eher umständlich wäre.

Ein optionaler `recurring_task_convert_to_workflow`-Endpoint ist denkbar, sobald
mehrere User explizit nach "Workflow draus machen" fragen. Bis dahin: in
RecurringTask löschen, im Canvas neu anlegen (per Template aus T-253).

## Templates als Brücke

Die Templates in `backend/src/workflows/workflow-templates.ts` decken die
typischen RecurringTask-Anwendungsfälle ab:

- **Wöchentliche Projekt-Triage** — Workflow-Pendant zu einem
  `weekly` `action: 'chat'` RecurringTask mit Todo-Analyse-Prompt.
- **Monatlicher Kunden-Check** — kundenweiter Status-Workflow.
- **Täglicher Projekt-Status** — Workflow mit Agent + Log-Node.
- **Release-Checkliste** — manueller Workflow, der Quest + Notification erzeugt.

Wer einen RecurringTask in einen Workflow überführen möchte, wählt im
"Neuer Workflow"-Dialog das passende Template, ersetzt Prompt/Cron, deaktiviert
den RecurringTask.

## Akzeptanzkriterien (T-255)

- ✓ Übergangsstrategie ist dokumentiert (dieses Dokument).
- ✓ Bestehende wiederkehrende Aufgaben laufen nach Einführung weiter
  (keine Schema-Breakage; alle neuen Felder optional/default).
- ✓ Neue Workflows können parallel genutzt werden (verschiedene Tabellen,
  verschiedene Scheduler-Pfade, keine Konflikte).
- Optionaler Migrationspfad: bewusst nicht implementiert — Begründung oben.
  Wenn nötig, eindeutiger Hook-Punkt: ein `recurring_task_convert_to_workflow`
  Service-Methode plus passender MCP-/REST-Endpoint.
