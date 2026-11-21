/**
 * Quick gateway WebSocket transport.
 *
 * Reconstructed from the renderer (Wx / IZe / Gx) and the main-process proxy
 * (dist/main/sncsWsProxy.js). Timing constants are the app's own:
 *   - WS keepalive ping every 45 s          (xZe = 45e3)
 *   - token refresh every 900 s             (PZe = 900e3)
 *   - protocol ping watchdog every 25 s, 2 misses -> terminate
 *   - inbound idle reaping at 60 s steady / 130 s during boot
 *
 * The transport is intentionally dumb: it frames and unframes JSON strings and
 * surfaces them as events. Session semantics live in session.ts.
 */

import WebSocket from 'ws';
import type { QuickSession } from './auth.js';
import { DEFAULT_WS_PATH, ALT_WS_PATH } from './auth.js';
import { WORKING_PATH } from './gateway-contract.js';
import {
  encodeOutbound,
  esDrain,
  decodeInbound,
  type EsMessage,
  type FramingMode,
  DEFAULT_FRAMING,
} from './codec.js';

// Must stay well inside the server's 95 s IDLE_TIMEOUT reap.
const WS_PING_INTERVAL_MS = 25_000;
const WS_PING_MAX_MISSED = 2;
const WS_INBOUND_IDLE_MS = 60_000;
const WS_INBOUND_IDLE_BOOT_MS = 130_000;
const WS_IDLE_CHECK_INTERVAL_MS = 15_000;
const APP_PING_INTERVAL_MS = 45_000;
const TOKEN_REFRESH_INTERVAL_MS = 900_000;
const CONNECT_TIMEOUT_MS = 30_000;

export interface HandshakeUrl {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build the WSS URL and headers.
 *
 * IMPORTANT 鈥?verified against the live gateway, not inferred from the binary:
 * the renderer builds a `Authorization: Bearer` header (IZe), but a raw `ws`
 * client sending that header is REFUSED with 401. The form that actually opens
 * the socket is the token in the QUERY string together with `surfaceType`.
 *
 * Probe results on a social tenant:
 *   path /streaming/quickwork-chat-bidirectional-stream + query auth  -> OPEN
 *   path /streaming/quickwork-chat-bidirectional-stream + header auth -> 401
 *   path /ws/service/.../ChatBidirectionalStream                      -> 404
 *
 * So `url` carries the auth and `headers` stays minimal. `authInHeader` exists
 * only so an enterprise tenant (where the header form is what the app uses) can
 * be tried without editing code.
 */
export function buildHandshake(
  session: QuickSession,
  opts: {
    framing?: FramingMode;
    channel?: string;
    agentRuntimeArnOverride?: string;
    /** Use the query-string auth form (default) or the header form. */
    auth?: 'query' | 'header';
    path?: string;
  } = {},
): HandshakeUrl {
  const path = opts.path ?? session.wsPath ?? WORKING_PATH;
  const url = new URL(`wss://${session.wsHost}${path}`);
  const auth = opts.auth ?? (process.env.QUICK_ACP_AUTH_IN_HEADER === '1' ? 'header' : 'query');

  // surfaceType is required by the server; without it the upgrade is refused.
  url.searchParams.set('surfaceType', session.surface);

  const headers: Record<string, string> = {
    'X-Surface-Type': session.surface,
    'X-Agent-Service-Type': 'UNIFIED_QUICK',
  };

  if (auth === 'query') {
    url.searchParams.set('token', session.jwt);
    if (session.outpostId) url.searchParams.set('outpostId', session.outpostId);
    if (session.workingSessionId) {
      url.searchParams.set('workingSessionId', session.workingSessionId);
    }
    // Deliberately no Authorization header: sending one makes the upgrade 401.
  } else {
    headers['Authorization'] = `Bearer ${session.jwt}`;
    if (session.outpostId) headers['X-Outpost-Id'] = session.outpostId;
    if (session.workingSessionId) headers['X-Working-Session-Id'] = session.workingSessionId;
  }

  const channel = opts.channel ?? process.env.QUICK_ACP_CHANNEL;
  if (channel === 'beta' || channel === 'prod') {
    headers['X-Channel'] = channel;
    url.searchParams.set('channel', channel);
  }

  if (opts.agentRuntimeArnOverride) {
    url.searchParams.set('agentRuntimeArnOverride', opts.agentRuntimeArnOverride);
  }

  return { url: url.toString(), headers };
}

export type TransportEvent =
  | { type: 'open' }
  | { type: 'message'; body: string }
  | { type: 'error'; body: string }
  | { type: 'close'; code: number; reason: string };

export type TransportListener = (ev: TransportEvent) => void;

export interface TransportOptions {
  framing?: FramingMode;
  /** Override the WS path (for probing the alternate production path). */
  pathOverride?: string;
  /** Called when the server rejects the JWT so the caller can refresh. */
  onTokenRefreshNeeded?: () => Promise<string | null>;
  debug?: boolean;
}

export class QuickTransport {
  private ws: WebSocket | null = null;
  private recvBuffer = new Uint8Array(0);
  private listeners = new Set<TransportListener>();
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private appPingTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private pendingPong = false;
  private missedPongs = 0;
  private sawInbound = false;
  private lastInboundAt = Date.now();
  private closedByUs = false;
  private readonly framing: FramingMode;
  private readonly debug: boolean;

  constructor(
    private session: QuickSession,
    private opts: TransportOptions = {},
  ) {
    this.framing = opts.framing ?? DEFAULT_FRAMING;
    this.debug = opts.debug ?? process.env.QUICK_ACP_DEBUG === '1';
  }

  on(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: TransportEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        this.log('listener threw', e);
      }
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.error('[quick-acp:ws]', ...args);
  }

  /** Dial and resolve once the socket is open, or reject with the reason. */
  async connect(): Promise<void> {
    const session = this.opts.pathOverride
      ? { ...this.session, wsPath: this.opts.pathOverride }
      : this.session;
    const { url, headers } = buildHandshake(session, { framing: this.framing });

    this.log('connecting to', url.replace(/(token=)[^&]*/, '$1<redacted>'));

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      this.ws = ws;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        reject(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        this.lastInboundAt = Date.now();
        this.log('open');
        this.startWatchdogs();
        this.emit({ type: 'open' });
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.lastInboundAt = Date.now();
        this.sawInbound = true;
        try {
          this.handleBinary(toUint8(data));
        } catch (e) {
          this.log('message handling error', e);
        }
      });

      ws.on('pong', () => {
        this.pendingPong = false;
        this.missedPongs = 0;
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        this.log('error', err.message);
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        this.emit({ type: 'error', body: err.message });
      });

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        this.stopWatchdogs();
        const text = reason?.toString() ?? '';
        this.log('close', code, text);
        if (!settled) {
          settled = true;
          reject(new Error(`closed before open (code ${code}) ${text}`.trim()));
          return;
        }
        if (!this.closedByUs) this.emit({ type: 'close', code, reason: text });
      });
    });
  }

  private handleBinary(buf: Uint8Array): void {
    const combined = new Uint8Array(this.recvBuffer.length + buf.length);
    combined.set(this.recvBuffer);
    combined.set(buf, this.recvBuffer.length);

    const { messages, consumed } = esDrain(combined, 0);
    this.recvBuffer = combined.slice(consumed);

    for (const msg of messages) {
      const ev = decodeInbound(msg, this.framing);
      if (ev.kind === 'error') {
        this.log('server error frame', ev.code, ev.body);
        this.emit({ type: 'error', body: ev.body });
      } else if (ev.kind === 'message') {
        this.log('recv', ev.body.slice(0, 200));
        this.emit({ type: 'message', body: ev.body });
      } else {
        this.log('ignored frame', ev.reason);
      }
    }
  }

  /** Send one JSON message using the configured framing. */
  send(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('socket is not open');
    }
    const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this.log('send', json.slice(0, 200));
    this.ws.send(encodeOutbound(json, this.framing));
  }

  /**
   * Send a message as a plain text frame, bypassing the codec.
   * The app does this for token_refresh (sncsWsSendRaw).
   */
  sendRaw(json: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('socket is not open');
    }
    this.log('sendRaw', json.slice(0, 200));
    this.ws.send(json);
  }

  private startWatchdogs(): void {
    // WS-level liveness; two missed pongs means the path is dead.
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.pendingPong) {
        this.missedPongs++;
        if (this.missedPongs >= WS_PING_MAX_MISSED) {
          this.log('ping timeout; terminating');
          this.terminate(4002, 'ping_timeout');
          return;
        }
      }
      this.pendingPong = true;
      try {
        this.ws.ping();
      } catch {
        /* socket died under us */
      }
    }, WS_PING_INTERVAL_MS);

    // Inbound data liveness; distinct from the ping watchdog because a dead
    // runtime still answers pings.
    this.idleTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const idleMs = Date.now() - this.lastInboundAt;
      const threshold = this.sawInbound ? WS_INBOUND_IDLE_MS : WS_INBOUND_IDLE_BOOT_MS;
      if (idleMs >= threshold) {
        this.log(`inbound idle ${Math.round(idleMs / 1000)}s; terminating`);
        this.terminate(4003, 'inbound_idle');
      }
    }, WS_IDLE_CHECK_INTERVAL_MS);
  }

  /** Start application-level ping and token refresh (call after session_connect). */
  startAppHeartbeat(): void {
    if (this.appPingTimer) return;
    this.appPingTimer = setInterval(() => {
      try {
        this.send({ type: 'ping', payload: { timestamp: Date.now() } });
      } catch {
        /* socket closed between ticks */
      }
    }, APP_PING_INTERVAL_MS);

    const refresh = this.opts.onTokenRefreshNeeded;
    if (refresh) {
      this.refreshTimer = setInterval(() => {
        void (async () => {
          try {
            const jwt = await refresh();
            if (!jwt) return;
            this.sendRaw(JSON.stringify({ type: 'token_refresh', token: jwt }));
          } catch (e) {
            this.log('token refresh failed', e);
          }
        })();
      }, TOKEN_REFRESH_INTERVAL_MS);
    }
  }

  private stopWatchdogs(): void {
    for (const t of [this.pingTimer, this.idleTimer, this.appPingTimer, this.refreshTimer]) {
      if (t) clearInterval(t);
    }
    this.pingTimer = null;
    this.idleTimer = null;
    this.appPingTimer = null;
    this.refreshTimer = null;
  }

  terminate(code = 1000, reason = 'client_close'): void {
    this.closedByUs = true;
    this.stopWatchdogs();
    try {
      this.ws?.close(code, reason);
    } catch {
      /* already closing */
    }
    this.ws = null;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Surface id, so the session layer can repeat it in business payloads. */
  get surface(): string {
    return this.session.surface;
  }

  /** Outpost id, likewise. */
  get outpostId(): string {
    return this.session.outpostId;
  }

  /** The tenant URL, for callers that need the HTTP origin. */
  get tenantUrl(): string {
    return this.session.tenantUrl;
  }
}

function toUint8(data: WebSocket.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data as Buffer);
}

export { DEFAULT_WS_PATH, ALT_WS_PATH };

