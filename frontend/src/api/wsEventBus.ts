/**
 * Single multiplexed WebSocket connection that replaces the three long-lived
 * /api/events EventSources (ConnectionStatus, NotificationBell,
 * useProjectEvents). Browsers limit HTTP/1.1 to ~6 concurrent connections
 * per origin; 3 SSE streams × N tabs starves the pool. WS connections live
 * in a separate, much larger pool.
 *
 * The bus is a process-singleton. App.tsx wires its lifecycle to the auth
 * state. Consumers subscribe with a scope filter and receive matching
 * events; the server applies the filter and forwards only relevant frames.
 *
 * Reconnect strategy: exponential backoff 1s → 30s on close/error. After
 * reconnect, all active subscriptions are replayed to the server. Heartbeat
 * is server-driven (ws.ping every 25s; browser auto-pongs at protocol
 * level), so background-tab throttling cannot break liveness.
 */
export type WsConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ProjectChangeEvent {
  projectId: string;
  entity:
    | 'project'
    | 'todo'
    | 'session'
    | 'knowledge'
    | 'changelog'
    | 'milestone'
    | 'manual'
    | 'research'
    | 'notification'
    | 'environment'
    | 'secret'
    | 'schema'
    | 'dependency'
    | 'feature'
    | 'soul'
    | 'commit'
    | 'recurring-task'
    | 'snippet'
    | 'doc-update-proposal'
    | 'knowledge-graph'
    | 'oracle';
  action: 'created' | 'updated' | 'deleted';
  entityId?: string;
}

export interface QuestionEvent {
  type: 'question_created' | 'question_answered';
  questionId: string;
  question?: string;
  options?: string[];
  context?: string;
  todoId?: string | null;
  projectId?: string | null;
  targetUserId?: string | null;
  expiresAt?: string;
  answer?: string;
  answeredByUserId?: string | null;
}

export type BusEvent = ProjectChangeEvent | QuestionEvent;

export interface SubscriptionScope {
  /** `global` receives every non-private event; `project` filters to one projectId. */
  kind: 'global' | 'project';
  projectId?: string;
}

type EventHandler = (event: BusEvent) => void;
type StateHandler = (state: WsConnectionState) => void;

interface Subscription {
  id: string;
  scope: SubscriptionScope;
  handler: EventHandler;
}

interface ServerEnvelope {
  type: 'hello' | 'subscribed' | 'event' | 'question';
  userId?: string | null;
  id?: string;
  subIds?: string[];
  payload?: BusEvent;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

class WsEventBus {
  private ws: WebSocket | null = null;
  private state: WsConnectionState = 'closed';
  private subs = new Map<string, Subscription>();
  private stateHandlers = new Set<StateHandler>();
  private getToken: (() => string | null) | null = null;
  private authEnabled = false;
  private started = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private nextSubId = 1;

  /**
   * Begin connecting. Idempotent — subsequent calls update the token getter
   * and trigger a reconnect only if the auth context actually changed.
   */
  start(getToken: () => string | null, authEnabled: boolean): void {
    const tokenChanged = this.getToken?.() !== getToken();
    const authModeChanged = this.authEnabled !== authEnabled;
    this.getToken = getToken;
    this.authEnabled = authEnabled;
    if (!this.started) {
      this.started = true;
      this.connect();
      return;
    }
    if (tokenChanged || authModeChanged) {
      // Tear down and reopen with the new credentials. Existing subs are
      // replayed automatically on the new connection.
      this.closeSocket();
      this.scheduleReconnect(0);
    }
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.setState('closed');
  }

  getState(): WsConnectionState {
    return this.state;
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  subscribe(scope: SubscriptionScope, handler: EventHandler): () => void {
    const id = `s${this.nextSubId++}`;
    const sub: Subscription = { id, scope, handler };
    this.subs.set(id, sub);
    this.sendSubscribe(sub);
    return () => {
      this.subs.delete(id);
      this.sendUnsubscribe(id);
    };
  }

  private setState(next: WsConnectionState) {
    if (this.state === next) return;
    this.state = next;
    for (const h of this.stateHandlers) h(next);
  }

  private connect() {
    if (!this.started) return;
    if (this.authEnabled && !this.getToken?.()) {
      // No token yet — wait for start() to be called again with credentials.
      this.setState('closed');
      return;
    }

    this.setState(this.ws ? 'reconnecting' : 'connecting');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    const token = this.getToken?.();
    if (token) params.set('token', token);
    const qs = params.toString();
    const url = `${proto}//${window.location.host}/api/ws/events${qs ? `?${qs}` : ''}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.setState('open');
      // Replay subscriptions after (re)connect so the server's filter table
      // matches the client's view.
      for (const sub of this.subs.values()) this.sendSubscribe(sub);
    };

    ws.onmessage = (msg) => {
      let env: ServerEnvelope;
      try {
        env = JSON.parse(msg.data) as ServerEnvelope;
      } catch {
        return;
      }
      if (env.type === 'event' || env.type === 'question') {
        const ids = env.subIds || [];
        const payload = env.payload;
        if (!payload) return;
        for (const id of ids) {
          const sub = this.subs.get(id);
          if (sub) {
            try {
              sub.handler(payload);
            } catch (err) {
              // Subscriber bugs must not kill the bus. Surface in console for
              // debugging without crashing other handlers.
              // eslint-disable-next-line no-console
              console.error('[wsEventBus] handler threw', err);
            }
          }
        }
      }
      // 'hello' and 'subscribed' are informational; no action required.
    };

    ws.onerror = () => {
      // Trigger the close path so the reconnect logic runs in one place.
      try { ws.close(); } catch { /* noop */ }
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.started) {
        this.setState('closed');
        return;
      }
      this.setState('reconnecting');
      this.scheduleReconnect(this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
  }

  private scheduleReconnect(delayMs: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private closeSocket() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    // Strip handlers so the close path doesn't schedule a reconnect when the
    // caller wanted a clean teardown.
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch { /* noop */ }
  }

  private sendSubscribe(sub: Subscription) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          type: 'subscribe',
          id: sub.id,
          scope: sub.scope.kind,
          projectId: sub.scope.projectId,
        }),
      );
    } catch {
      /* noop — onclose will trigger reconnect */
    }
  }

  private sendUnsubscribe(id: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', id }));
    } catch {
      /* noop */
    }
  }
}

export const wsEventBus = new WsEventBus();

export function isProjectChangeEvent(e: BusEvent): e is ProjectChangeEvent {
  return 'entity' in e;
}

export function isQuestionEvent(e: BusEvent): e is QuestionEvent {
  return 'type' in e && (e.type === 'question_created' || e.type === 'question_answered');
}
