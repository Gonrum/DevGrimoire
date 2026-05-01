# UI Guidelines

This document captures the current frontend UI conventions so new screens do not reinvent patterns already present in `frontend/src/components`.

## Source of Truth

Prefer shared components before adding page-local controls:

| Need | Use |
| --- | --- |
| Buttons and inline actions | `frontend/src/components/ui/Button.tsx` |
| Destructive confirmation | `frontend/src/components/ui/ConfirmButton.tsx` |
| Status labels and small metadata | `frontend/src/components/ui/Badge.tsx` |
| Bordered content containers | `frontend/src/components/ui/Card.tsx` |
| Basic fields | `frontend/src/components/ui/FormField.tsx` |
| Modal shell | `frontend/src/components/ui/Dialog.tsx` |
| Empty content states | `frontend/src/components/ui/EmptyState.tsx` |
| Markdown editing | `frontend/src/components/MarkdownEditor.tsx` |

When a page needs a variation that appears more than once, extend a shared component or add a small primitive instead of copying raw Tailwind classes.

## Layout Rules

- Use stable page shells for repeated workflows such as create/edit/detail pages.
- Keep content widths intentional. Existing form pages commonly use `max-w-3xl mx-auto`.
- In flex rows, field wrappers must grow explicitly. `FormInput`, `FormSelect`, and `MarkdownEditor` make the inner control `w-full`, but their wrapper still needs `flex-1` or a shared field-with-action primitive when placed next to buttons.
- Avoid negative margins for form alignment; fix the layout contract instead.
- Keep mobile behavior explicit with `flex-col sm:flex-row`, `w-full`, and fixed action slots where needed.

## Component Usage

### Buttons

Use `Button` variants before custom classes:

- `primary` for primary submit/create actions
- `secondary` for neutral actions
- `danger` or `danger-solid` for destructive actions
- `ghost` and `ghost-blue` for low-emphasis inline actions

Avoid `variant="none"` unless a component is intentionally defining a new reusable variant. If the same ad-hoc button styling appears twice, promote it into `Button`.

### Forms

Use `FormInput`, `FormSelect`, and `FormTextarea` for standard labeled fields. For Markdown content, use `MarkdownEditor`.

Common expected patterns:

- title and description fields take the full available row width
- field/action rows reserve a fixed slot for actions such as dictation
- selects and inline create inputs align to the same grid as the rest of the form
- raw `input`, `select`, and `textarea` are acceptable only for one-off behavior that shared fields cannot express yet

If raw controls are needed repeatedly, add the missing capability to the shared form components.

### Cards and Sections

Use `Card` for repeated framed items and contained panels. Do not nest cards inside cards. Page sections should generally be unframed layouts or full-width bands; cards are for individual units, modals, and explicit panels.

### Badges and Status Colors

Use `Badge` for status and compact metadata. Keep semantic colors consistent by defining status color maps near the feature or moving common maps into a shared utility when reused.

## Visual Style

The app uses a dark dashboard style with restrained violet/cyan accents:

- primary surfaces: `gray-950`, `gray-900`, `gray-800`
- borders: `gray-800`, `gray-700`
- primary accent: `violet`
- secondary accent: `cyan`
- destructive: `red`
- success: `green`
- warning/progress: `yellow`

Use the grimoire-specific effects in `frontend/src/index.css` sparingly:

- `glow-violet`
- `glow-cyan`
- `grimoire-card`
- `grimoire-divider`
- `quest-status-changed`
- `quest-status-done`

## Accessibility and Responsiveness

- Keep focus states visible; existing form fields use `focus:border-violet-500`.
- Respect reduced motion. Global animation helpers already disable major effects under `prefers-reduced-motion`.
- Make buttons and fields usable on mobile; avoid fixed-width text controls that can overflow.
- Do not rely on color alone for critical state when text or icon context is available.

## Review Checklist

Before merging UI work:

- Existing shared components were used or extended.
- Repeated page-local Tailwind patterns were promoted into components.
- Form fields use full available width in page and modal contexts.
- Mobile layout was checked for wrapping and overflow.
- Button variants and status colors are consistent with nearby screens.
- No new card-in-card layout was introduced.
