# MCP Apps Support in DevGrimoire (M-35 Spike)

DevGrimoire implementiert seit M-35 einen schmalen Prototyp der [**MCP Apps
Extension**](https://github.com/modelcontextprotocol/ext-apps) (SEP-1865,
Stable 2026-01-26) — interaktive UI-Resourcen, die kompatible Hosts neben den
klassischen Text-/JSON-Tool-Resultaten anzeigen können.

> **Scope:** read-only Single-Entity-View für Todos. Bewusst klein gehalten,
> damit Spec-Mapping, Sicherheitsmodell und Fallback-Garantie sauber
> nachvollziehbar bleiben. Ausbau auf Workflows, Whiteboards und
> Research-Sessions folgt in eigenen Milestones.

---

## 1. Spec-Mapping

| Spec-Konzept | DevGrimoire-Umsetzung |
|---|---|
| **Extension-ID** `io.modelcontextprotocol/ui` | Vom Host advertised; Server liefert immer additiv und vertraut auf Host-Fallback |
| **UI-Resource** `ui://…` mit MIME `text/html;profile=mcp-app` | `ui://devgrimoire/todo` in `backend/src/mcp-apps/resources.ts` |
| **`resources/list`** | Neuer Handler in `mcp-tools.ts` listet alle UI-Resourcen unabhängig von normalen MCP-Resources |
| **`resources/read`** | Liefert HTML-String + `_meta.ui.csp` (default-restriktiv, keine externen Origins) + `_meta.ui.prefersBorder: true` |
| **Tool-UI-Linkage** `_meta.ui.resourceUri` | `todo_get` Tool-Definition trägt `_meta.ui.resourceUri = "ui://devgrimoire/todo"` |
| **`_meta.ui.visibility`** | Default `["model", "app"]` (nicht gesetzt — Tool bleibt für Model und App callable) |
| **Capability-Negotiation** | Server registriert die UI-Resource immer; Clients ohne `extensions["io.modelcontextprotocol/ui"]` ignorieren `_meta.ui` und die Resource — Fallback ist automatisch |
| **Bidirectional Communication** via `postMessage` JSON-RPC | View liest Tool-Daten aus `ui/notifications/tool-result` und ruft `todo_update` via `tools/call` (proxied vom Host) |
| **iframe-Sandboxing** | Pflicht beim Host. Wir setzen restriktives CSP (`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'`) und keine `connectDomains`/`resourceDomains` → kein externer Traffic |
| **Audit-Trail** | View-initiierte `tools/call` laufen durch unsere existierende `AuditLogService`-Pipeline wie jeder andere MCP-Tool-Call |
| **`text/html;profile=mcp-app`** | Pflicht-MIME für Apps, vom Server gesetzt |

---

## 2. Sicherheitsmodell

### 2.1 Default-restriktives CSP

Die UI-Resource deklariert KEINE `connectDomains`, `resourceDomains`,
`frameDomains` oder `baseUriDomains`. Der Host MUSS daraus die
spec-konformen restriktiven Defaults setzen:

```
default-src 'none';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
media-src 'self' data:;
connect-src 'none';
frame-src 'none';
base-uri 'self';
object-src 'none';
```

Effekt: Die View kann inline-Skripte und -Styles, aber **keine** externen
Requests, Embeds oder Tracker laden.

### 2.2 Keine erhöhten Browser-Permissions

`_meta.ui.permissions` ist leer. Camera, Microphone, Geolocation und
Clipboard-Write werden **nicht** angefordert.

### 2.3 Auditable Communication

Jeder `tools/call` aus der View geht durch den normalen MCP-Pfad und damit
durch den `AuditLogService` (Action `mcp.tool.call`). Der `actor`-Kontext
trägt die User-Identität aus der MCP-Session.

### 2.4 Bedrohungen aus dem Spec-Threat-Model und unsere Antworten

| Bedrohung | Antwort |
|---|---|
| Malicious server delivers harmful HTML | Wir SIND der Server — der HTML-Inhalt ist Teil unseres Source-Codes (`backend/src/mcp-apps/todo-view.html.ts`) und reviewbar |
| Compromised View escapes sandbox | Host-Sandbox-Pflicht (Spec §Sandbox proxy) |
| Unauthorized tool execution from View | Standard MCP-Auth gilt — die View hat die gleichen Tool-Rechte wie der MCP-Caller; `_meta.ui.visibility: ["app"]` ist NICHT gesetzt, alle vom Tool aufrufbaren Tools sind auch vom Model aufrufbar (kein Privilege-Escalation-Vektor) |
| Data exfiltration | `connect-src 'none'` blockiert externe Endpoints |
| Phishing / Social Engineering | Spec-konform: Host MUSS sandboxed UI klar kennzeichnen — DevGrimoire kann das nicht garantieren, hängt am Host |

---

## 3. Wie es implementiert ist

### 3.1 Server-Capabilities

`backend/src/mcp-server.ts`:

```typescript
const server = new Server(
  { name: 'DevGrimoire', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);
```

### 3.2 UI-Resource-Definition

`backend/src/mcp-apps/resources.ts`:

```typescript
export const TODO_UI_RESOURCE_URI = 'ui://devgrimoire/todo';
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';

export const UI_RESOURCES = [
  {
    uri: TODO_UI_RESOURCE_URI,
    name: 'Todo Detail View',
    description: 'Read-only interactive Todo card with status quick-actions',
    mimeType: UI_MIME_TYPE,
  },
];
```

### 3.3 Handler `resources/list` und `resources/read`

In `registerMcpTools` zusätzlich zu den bestehenden Tool-Handlern registriert.
Liefert die UI-Resource-Definition bzw. den HTML-Inhalt mit
`_meta.ui.prefersBorder: true`.

### 3.4 Tool-Annotation

`todo_get` bekommt `_meta.ui.resourceUri = TODO_UI_RESOURCE_URI` in
seiner Definition. Kein anderes Verhalten — Hosts ohne Apps-Support
sehen nur die normale Tool-Antwort.

### 3.5 View-HTML (Kurzfassung)

Inline-Script in `todo-view.html.ts`:

1. Auf `message`-Event hören und `ui/initialize` aus dem Host erwarten
2. Auf `ui/notifications/tool-result` warten — enthält die `Todo`-JSON
3. Rendern: Titel, Status, Priorität, Beschreibung (Markdown), Tags
4. Status-Quick-Actions (`open / in_progress / review / done`) → ruft
   `tools/call` mit `name: "todo_update"` über `postMessage` zum Host
5. Host proxied an unseren MCP-Server, wir antworten normal, View
   re-rendert

---

## 4. Fallback-Garantie

- **Clients ohne MCP-Apps-Support**: Ignorieren `resources/list` (oder rufen
  es gar nicht), ignorieren `_meta.ui.resourceUri`. `todo_get` verhält sich
  identisch zu vor M-35: JSON-Antwort.
- **Bestehende MCP-Tools**: Keine Signatur-Änderungen. Alle Tool-Names,
  Input-Schemata und Response-Shapes bleiben gleich.
- **Discovery / `server.json`**: Kein Update nötig — die Resources sind
  über `resources/list` discoverable, was Apps-fähige Clients ohnehin
  abfragen.

---

## 5. Kompatible Hosts (Stand 2026-05-27)

Die Apps-Extension ist seit Januar 2026 stable. Reale Host-Implementierungen
zum Zeitpunkt dieses Spikes:

| Host | Status | Hinweise |
|---|---|---|
| Claude Desktop | unterstützt experimentell | Spec-konformer Sandbox-Pfad, sieht UI-Resources über `resources/list` |
| ChatGPT (OpenAI Apps SDK) | eigene Variante | Liefert Apps-SDK-Format; unser `_meta.ui` ist additiv und stört nicht |
| Cursor / Continue / weitere Code-Hosts | meist noch ohne Apps-Support | Fallback greift — `todo_get` liefert JSON wie bisher |
| `mcp-remote`-Wrapper (Stdio↔HTTP) | transparent | Reicht Resource-Calls 1:1 durch |

**Testpfad:** Im Claude Desktop nach Update auf eine Apps-fähige Version
`todo_get` aufrufen; die View sollte als zweite Karte neben der
JSON-Antwort erscheinen.

---

## 6. Grenzen und nächste Schritte

- **Nur ein Entity-Type**: Aktuell nur Todos. Whiteboards, Workflow-Canvas
  und Research-Sessions sind die naheliegenden Folge-Kandidaten.
- **Kein Display-Mode `fullscreen`/`pip`**: View deklariert nur `inline` in
  `appCapabilities.availableDisplayModes`.
- **Kein Theming-Subscriber**: View nutzt keine `HostContext.styles.variables`
  noch nicht — eigene Farben mit Tailwind-ähnlichen Defaults.
- **Keine `ui/request-display-mode`**-Implementation: View kann den Mode
  nicht aktiv wechseln.
- **Keine View-to-View-Communication**: Out-of-scope laut Spec (deferred).
- **Audit-Hash der Resources**: Spec empfiehlt Hash/Signatur — aktuell
  nicht generiert, der Server liefert den HTML-Inhalt bei jedem Read aus
  derselben Source-Konstante.

---

## 7. References

- Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- MCP-UI (Reference Implementation): https://mcpui.dev/
- OpenAI Apps SDK Validation: https://modelcontextprotocol.io/development/roadmap
- DevGrimoire-Implementation: `backend/src/mcp-apps/`
