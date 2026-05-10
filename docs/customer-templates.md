# Customer Templates

Customer templates define repeatable, non-secret setup blueprints for new customers. They should speed up onboarding without copying sensitive data or hiding what was created.

## Goals

- Create standard customer setup from reusable templates.
- Keep every generated todo, monitoring check, environment, contact type, and workflow editable after creation.
- Record which template created which entities so operators can audit and correct the result.
- Make templates usable from UI first, then from MCP/Chat once tool permissions are explicit.
- Never store real secret values in templates.

## Template types

| Type | Purpose | Generated examples |
| --- | --- | --- |
| `onboarding` | End-to-end customer bootstrap | intro todo list, required contacts, default environments |
| `todo_list` | Repeatable operational/customer tasks | kickoff checklist, access review, handover tasks |
| `monitoring` | Baseline health checks | website ping, certificate expiry, backup freshness |
| `environment` | Standard environment shells | production, staging, development metadata |
| `workflow` | Automation starting points | weekly status report, incident follow-up |
| `contact_type` | Expected contact roles | technical owner, billing, escalation |

## Data model sketch

```ts
interface CustomerTemplate {
  _id: ObjectId;
  name: string;
  slug: string;
  description?: string;
  type: 'onboarding' | 'todo_list' | 'monitoring' | 'environment' | 'workflow' | 'contact_type';
  active: boolean;
  version: number;
  tags: string[];
  items: CustomerTemplateItem[];
  createdBy?: ObjectId;
  updatedBy?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

interface CustomerTemplateItem {
  kind: 'todo' | 'monitoring_check' | 'environment' | 'workflow' | 'contact_type' | 'note';
  title: string;
  description?: string;
  payload: Record<string, unknown>;
  requiredSecretKeys?: string[];
  placeholders?: Record<string, string>;
}
```

Generated entities should receive a small provenance block:

```ts
interface TemplateProvenance {
  templateId: ObjectId;
  templateVersion: number;
  appliedAt: Date;
  appliedBy: ObjectId;
  customerId: ObjectId;
}
```

## Secret boundary

Templates may contain secret *requirements*, never values:

```json
{
  "kind": "environment",
  "title": "Production",
  "payload": {
    "name": "production",
    "urlPlaceholder": "https://example.customer.tld"
  },
  "requiredSecretKeys": ["DEPLOY_TOKEN", "BACKUP_ACCESS_KEY"]
}
```

Applying a template may create missing secret metadata/placeholders if DevGrimoire supports that flow, but it must not fill encrypted secret values. The UI should show required missing secrets after template application.

## Application flow

1. User creates a customer or opens an existing customer.
2. UI offers active templates filtered by type/tags.
3. User previews generated entities before applying.
4. Backend validates:
   - customer access permissions
   - template is active
   - no secret values are present in template items
   - generated entities pass their normal validators
5. Backend creates entities in one best-effort application transaction where practical.
6. Backend writes an activity/log entry with template id, version, customer id, and generated entity ids.
7. UI shows a post-apply summary and direct edit links.

## API sketch

Additive endpoints keep the feature safe to introduce:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/customer-templates?type=&active=` | List templates |
| `POST` | `/api/customer-templates` | Create template |
| `GET` | `/api/customer-templates/:id` | Read template |
| `PUT` | `/api/customer-templates/:id` | Update template |
| `POST` | `/api/customer-templates/:id/preview` | Preview generated entities for a customer |
| `POST` | `/api/customer-templates/:id/apply` | Apply template to a customer |

MCP/Chat tools should be read-only first (`customer_template_list`, `customer_template_preview`). Write tools (`customer_template_apply`) should require explicit tool allowlist and normal customer/project scope checks.

## MVP template catalog

- **New managed customer onboarding**
  - contact types: technical owner, billing owner, escalation contact
  - environments: production, staging
  - todos: collect access, confirm backup owner, document deploy path
  - monitoring: public URL check, certificate expiry, backup freshness placeholder
- **Monthly customer operations**
  - todos: review open incidents, check pending invoices, verify backup status
  - workflow: monthly status summary draft
- **Project handover**
  - todos: document repository, deployment, secrets required, runbook location
  - note: handover checklist with placeholders

## Acceptance mapping

- **Wiederkehrende Kundeneinrichtung kann aus Templates erzeugt werden:** `apply` endpoint creates standard entities from template items.
- **Keine sensiblen Daten duplizieren:** templates support `requiredSecretKeys`, not secret values; validators reject secret-looking fields.
- **Nachvollziehbar und korrigierbar:** generated entities carry provenance and remain normal editable entities.
- **UI und MCP/Chat nutzbar:** API is preview-first; MCP write access is gated by tool allowlists and scopes.

## Implementation order

1. Add schema/service for `CustomerTemplate` plus seedable built-in templates.
2. Add preview/apply backend endpoints with secret-value validation.
3. Add customer detail UI: template picker, preview, apply summary.
4. Add read-only MCP tools; add apply tool only after permission review.
5. Add tests for secret rejection, provenance, and generated entity editability.
