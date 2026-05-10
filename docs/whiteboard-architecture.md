# ADR: Whiteboard Architecture and Data Format

Status: proposed

Date: 2026-05-09

Related todos:

- Architecture decision and data format for Whiteboard
- Backend Whiteboard entity + CRUD REST + MCP tools
- Canvas engine renderer, viewport, pan/zoom
- Canvas tool state machine and basic shapes

## Context

DevGrimoire needs a native Whiteboard module for visual project thinking: diagrams, schema sketches, arrows, annotations, and later LLM-readable exports. The first implementation should be simple enough to ship, but structured enough to support undo/redo, autosave, thumbnails, MCP tools, and future collaboration.

The main decisions before coding are:

1. renderer technology,
2. persisted document format,
3. coordinate system,
4. hit-testing strategy,
5. editing/undo model,
6. autosave and concurrency approach,
7. how schemas and LLM exports fit in.

## Decision summary

| Area | Decision |
| --- | --- |
| Renderer | HTML5 Canvas 2D for the MVP |
| Persisted format | Versioned JSON document stored on `Whiteboard.content` |
| Coordinates | World-space document coordinates with viewport transform helpers |
| Node storage | `Record<string, WhiteboardNode>` keyed by stable ids |
| Edge storage | `Record<string, WhiteboardEdge>` keyed by stable ids |
| Selection/edit state | UI/runtime state, not persisted except optional viewport |
| Undo/redo | Command pattern over immutable document patches |
| Autosave | Debounced save with optimistic `revision` checks |
| Thumbnail | Client-rendered PNG thumbnail stored separately |
| LLM access | Dedicated text/Mermaid/PNG MCP tools, not raw internal UI state |

## Renderer choice

### Options considered

#### Canvas 2D

Pros:

- Good fit for many simple shapes and freehand strokes.
- Predictable performance for 1,000+ simple nodes if dirty rendering and culling are used.
- Easy thumbnail generation via offscreen/secondary canvas.
- Works well with custom hit testing and world-space transforms.
- Lower conceptual overhead than WebGL.

Cons:

- DOM accessibility is not automatic.
- Text editing needs an overlay `<textarea>` or contenteditable element.
- Hit-testing, selection boxes, and resize handles must be implemented manually.

#### SVG

Pros:

- Native DOM elements, event targets, and scalable rendering.
- Easier basic hit-testing via browser events.
- Text and accessibility can be simpler.

Cons:

- Large diagrams with many nodes/edges/freehand strokes can become DOM-heavy.
- Complex interactions still need custom state management.
- Thumbnail/export path still needs SVG serialization or conversion.

#### WebGL

Pros:

- Best long-term rendering performance for very large or highly visual boards.
- Good for advanced effects and massive freehand content.

Cons:

- Overkill for MVP.
- More complex text rendering and shape editing.
- Harder to keep implementation approachable.

### Decision

Use **HTML5 Canvas 2D** for MVP.

Reasoning: Canvas 2D is the best balance of performance, implementation effort, thumbnail generation, and custom whiteboard behavior. It avoids SVG DOM bloat without introducing WebGL complexity. If future boards exceed Canvas 2D limits, the persisted document model can remain stable while rendering internals evolve.

## Persisted data format

Persist a versioned JSON document in `Whiteboard.content`.

```ts
export interface WhiteboardDoc {
  version: 1;
  nodes: Record<string, WhiteboardNode>;
  edges: Record<string, WhiteboardEdge>;
  viewport: ViewportState;
  metadata?: WhiteboardMetadata;
}

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface WhiteboardMetadata {
  title?: string;
  updatedBy?: string;
  lastTool?: WhiteboardTool;
}

export type WhiteboardTool = 'select' | 'pan' | 'rect' | 'text' | 'arrow';
```

`version` is required so future migrations can transform documents safely. Runtime-only state such as dragging, hover target, active handle, in-progress text edit, and unsaved command stack must not be persisted in `content`.

## Node model

Use a discriminated union keyed by `type`.

```ts
export type WhiteboardNode =
  | RectNode
  | TextNode
  | SchemaNode
  | ArrowNode
  | FreehandNode;

interface BaseNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  style?: NodeStyle;
  locked?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface RectNode extends BaseNode {
  type: 'rect';
  text?: string;
}

export interface TextNode extends BaseNode {
  type: 'text';
  text: string;
  fontSize?: number;
  fontFamily?: string;
}

export interface SchemaNode extends BaseNode {
  type: 'schema';
  schemaId: string;
  collapsed?: boolean;
  fieldVisibility?: Record<string, boolean>;
}

export interface ArrowNode extends BaseNode {
  type: 'arrow';
  from: AnchorRef | PointRef;
  to: AnchorRef | PointRef;
  label?: string;
  style?: EdgeStyle;
}

export interface FreehandNode extends BaseNode {
  type: 'freehand';
  points: Array<{ x: number; y: number; pressure?: number }>;
  strokeWidth?: number;
}
```

Notes:

- `RectNode` can carry simple inline text to cover sticky-note-like use cases.
- `TextNode` is for standalone text with overlay editing.
- `SchemaNode` embeds a live reference to a DevGrimoire schema entity; cached display fields may be added later, but `schemaId` is the source of truth.
- `ArrowNode` can represent a free arrow independent from graph edges. Semantic graph connections should use `WhiteboardEdge`.
- `FreehandNode` stores points in world-space and can later be simplified/compressed.

## Edge model

Use separate edges for semantic relationships between nodes.

```ts
export interface WhiteboardEdge {
  id: string;
  fromNodeId: string;
  fromAnchor?: string;
  toNodeId: string;
  toAnchor?: string;
  label?: string;
  style?: EdgeStyle;
  createdAt?: string;
  updatedAt?: string;
}

export interface AnchorRef {
  nodeId: string;
  anchor?: string;
}

export interface PointRef {
  x: number;
  y: number;
}
```

Edges are preferable when the relationship is tied to nodes and should survive node movement. `ArrowNode` is preferable for free-form visual arrows that are not semantic graph edges.

## Styling

Start with a compact style model and expand only when needed.

```ts
export interface NodeStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  textColor?: string;
}

export interface EdgeStyle {
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  arrowStart?: boolean;
  arrowEnd?: boolean;
}
```

Use DevGrimoire defaults when values are absent. This keeps documents small and makes theme changes easier.

## Coordinate system

Persist all geometry in **world-space**. The canvas viewport maps world-space to screen-space.

```ts
export function worldToScreen(point: Point, viewport: ViewportState): Point {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}

export function screenToWorld(point: Point, viewport: ViewportState): Point {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}
```

Rules:

- Mouse/pointer coordinates are converted to world-space before editing documents.
- Render code applies viewport transform once per frame.
- Selection boxes and resize handles can be computed in world-space then rendered in screen-space.
- Grid spacing is world-space based and visually scaled by zoom.
- Clamp zoom to `0.1` through `8` for MVP.

## Hit-testing

Implement explicit hit-testing in `engine/hitTest.ts`.

Recommended API:

```ts
export function findNodeAt(point: Point, doc: WhiteboardDoc): WhiteboardNode | null;
export function findEdgeAt(point: Point, doc: WhiteboardDoc): WhiteboardEdge | null;
export function findResizeHandleAt(point: Point, selection: SelectionState, doc: WhiteboardDoc): ResizeHandle | null;
```

Strategy:

1. Convert pointer to world-space.
2. Iterate nodes in reverse render order.
3. Check type-specific bounding geometry.
4. For text and rect, start with axis-aligned bounding boxes.
5. For freehand strokes, use distance-to-polyline with a tolerance scaled by zoom.
6. For edges, use distance-to-segment/polyline.
7. Prefer handles over nodes, and nodes over edges.

MVP can ignore rotated hit boxes if rotation is not exposed yet.

## Render loop

Use a dirty render loop, not continuous redraw.

```ts
interface RenderState {
  dirty: boolean;
  doc: WhiteboardDoc;
  viewport: ViewportState;
  selection: SelectionState;
}
```

Rules:

- Mark dirty on document changes, viewport changes, selection changes, hover changes, or canvas resize.
- Render through `requestAnimationFrame` when dirty.
- Account for `devicePixelRatio` during canvas setup.
- Clear canvas, apply viewport transform, draw grid, draw nodes/edges, draw selection overlays.
- Keep pure draw functions independent from React where possible so PNG rendering can reuse them later.

## Tool state machine

MVP tools:

```ts
export type ToolState =
  | { tool: 'select'; mode: 'idle' | 'dragging' | 'resizing' }
  | { tool: 'pan'; mode: 'idle' | 'panning' }
  | { tool: 'rect'; mode: 'idle' | 'drawing' }
  | { tool: 'text'; mode: 'idle' | 'editing' }
  | { tool: 'arrow'; mode: 'idle' | 'drawing' };
```

Keyboard shortcuts:

- `V` select
- `H` pan
- `R` rect
- `T` text
- `A` arrow
- `Escape` cancel current action
- `Delete`/`Backspace` delete selected nodes/edges after confirmation if needed
- `Ctrl+Z` undo
- `Ctrl+Shift+Z` or `Ctrl+Y` redo
- `Ctrl+0` reset viewport

Delete should remove selected whiteboard items only after the current command is explicit and recoverable through undo.

## Undo/redo

Use command objects rather than mutating ad-hoc state.

```ts
interface WhiteboardCommand {
  id: string;
  label: string;
  apply(doc: WhiteboardDoc): WhiteboardDoc;
  revert(doc: WhiteboardDoc): WhiteboardDoc;
}
```

Example commands:

- `CreateNodeCommand`
- `MoveNodesCommand`
- `ResizeNodeCommand`
- `UpdateTextCommand`
- `CreateEdgeCommand`
- `DeleteSelectionCommand`

Guidelines:

- A drag operation should become one command when the pointer is released, not one command per mousemove.
- Commands operate on immutable copies or structural patches.
- Autosave saves the resulting document, not the command stack.
- Command stack is session-local for MVP.

## Autosave and concurrency

The backend Whiteboard entity should include:

```ts
interface WhiteboardRecord {
  projectId: string;
  title: string;
  description?: string;
  content: WhiteboardDoc;
  thumbnail?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

Save behavior:

- Debounce autosave to 1 second after the last document change.
- Send `content`, `thumbnail`, and expected `revision`.
- Backend increments `revision` on success.
- If revision mismatches, return `409 Conflict`.
- MVP conflict UI shows “Another session saved changes. Reload required.” with a reload button.
- Later collaboration can add merge or CRDT behavior without changing the initial document shape drastically.

## Thumbnail generation

Generate thumbnails client-side from the same render primitives:

- Target size: `320x200`.
- Include content bounds with padding.
- Store as PNG data URL/base64 in `thumbnail`.
- Use placeholder icon when thumbnail is absent.
- Regenerate on save, not every pointer move.

Keep thumbnail separate from `content` so LLM/MCP tools can request content without carrying image payloads.

## Schema nodes

`SchemaNode` embeds DevGrimoire schema entities visually.

Rendering:

- Header: schema name + database type badge.
- Rows: fields with type, required marker, primary-key/index markers.
- Anchors: left/right anchor points per field for edges.
- Collapsed mode: header only.

Data:

- Persist `schemaId`, `collapsed`, optional field visibility.
- Resolve current schema details when loading/rendering.
- Later add cached display snapshot if historical fidelity becomes important.

## LLM and MCP access

Do not force agents to consume raw UI JSON for common tasks. Add purpose-built tools:

- `whiteboard_describe`: compact structured text description.
- `whiteboard_to_mermaid`: graph-like export when board has node/edge structure.
- `whiteboard_render_png`: server-side or shared-renderer PNG for vision models.

Security/size rules:

- Respect project/API-key scope.
- Omit or summarize huge freehand content by default.
- Cap PNG size.
- Never include secrets from linked schemas/environments.

## Migration strategy

Because `WhiteboardDoc.version` is explicit, future migrations should be pure functions:

```ts
function migrateWhiteboardDoc(input: unknown): WhiteboardDoc {
  // validate, upgrade version, fill defaults
}
```

Backend should validate content shape on save and reject unknown future versions. Frontend should tolerate missing optional style fields and fill defaults.

## Initial file/module layout

Recommended frontend layout:

```text
frontend/src/whiteboard/
  WhiteboardCanvas.tsx
  types.ts
  engine/
    Renderer.ts
    Viewport.ts
    hitTest.ts
    commands.ts
    thumbnail.ts
  tools/
    selectTool.ts
    panTool.ts
    rectTool.ts
    textTool.ts
    arrowTool.ts
```

Recommended backend layout:

```text
backend/src/whiteboards/
  whiteboards.module.ts
  whiteboards.controller.ts
  whiteboards.service.ts
  schemas/whiteboard.schema.ts
  dto/create-whiteboard.dto.ts
  dto/update-whiteboard.dto.ts
```

## Consequences

Positive:

- Clear MVP path with low rendering complexity.
- Stable persisted model independent from React internals.
- Undo/redo and autosave have clean boundaries.
- Later MCP/LLM tools have a predictable source format.
- Canvas 2D can share render primitives for thumbnails and PNG export.

Tradeoffs:

- More custom interaction code than SVG.
- Accessibility needs deliberate UI alternatives and keyboard support.
- Text editing requires an overlay input.
- Real-time collaboration is deferred.

## Open decisions

- Should z-order be implicit insertion order or explicit `zIndex`? Recommendation: start with insertion/render order, add `zIndex` only when layering UI needs it.
- Should `ArrowNode` and `WhiteboardEdge` both exist? Recommendation: yes; free-form arrows and semantic edges serve different purposes.
- Should schema nodes cache display snapshots? Recommendation: not in MVP; resolve live schema data and revisit if historical fidelity matters.
- Should command stack survive reload? Recommendation: no for MVP; keep it session-local.
- Should thumbnails be generated client-side or server-side? Recommendation: client-side first, server-side/shared renderer later for MCP PNG export.

## Acceptance criteria covered

- Renderer decision documented: Canvas 2D.
- State shape documented with TypeScript interfaces.
- Coordinate system and transform helpers documented.
- Hit-testing approach documented.
- Undo/redo command model documented.
- Autosave/revision and thumbnail approach documented.
- Schema nodes and LLM/MCP export path documented.
