/**
 * Quick conversation session.
 *
 * Verified against the live gateway. The inbound frame shapes handled here are
 * the ones actually observed, not the ones guessed from the renderer:
 *
 *   message_start     {payload:{role}, message_id, thread_id}
 *   title_generated   {payload:{conversation_id,title}}
 *   thinking_start    {payload:{type, kernel_thread_id}}
 *   thinking_delta    {payload:{type, delta, kernel_thread_id}}
 *   thinking_complete {payload:{...}}
 *   text_delta        {payload:{delta, kernel_thread_id}, message_id, thread_id}
 *   turn_usage        {payload:{input_tokens,output_tokens,cache_read_tokens,
 *                               cache_write_tokens,resolved_model_id}}
 *   text_complete     {payload:{text}, message_id, thread_id}
 *   message_complete  {payload:{text, tool_calls, initiator}}
 *   tool_start / tool_arguments / tool_progress / tool_result   (server-side tools)
 *
 * CORRECTION: an earlier version of this header asserted "There is NO
 * `thinking_delta` in the observed chat flow". That was wrong, and the way it
 * was wrong is instructive: the tests behind it asked for single-word answers,
 * which never engage reasoning, so the frames never appeared. With a prompt that
 * invites thinking, the gateway streams `thinking_start` + many `thinking_delta`
 * frames. Treating their absence as a protocol fact silently discarded every
 * reasoning token.
 *
 * The usage frame really is called `turn_usage` (not `token_usage`), and the
 * server-side tool frame really is `tool_result` (not `tool_end`) — both names
 * matter.
 *
 * STRUCTURAL CONSTRAINT (unchanged): the wire protocol sends an incremental
 * turn against a server-held `thread_id`. It does not accept a message history.
 * A fresh UUID thread is accepted and creates a new conversation, which is what
 * makes one-turn-at-a-time operation possible without a prior session_list.
 */
import { randomUUID } from 'node:crypto';
import { HOUSEKEEPING_FRAME_TYPES, TURN_END_FRAME_TYPES, } from './gateway-contract.js';
export class QuickChatSession {
    opts;
    state = null;
    connected = false;
    activeMessageId = null;
    activeHandler = null;
    debug;
    constructor(opts) {
        this.opts = opts;
        this.debug = opts.debug ?? process.env.QUICK_ACP_DEBUG === '1';
    }
    log(...args) {
        if (this.debug)
            console.error('[quick-acp:session]', ...args);
    }
    /** Open the gateway and perform session_connect. */
    async open() {
        if (this.connected)
            return;
        this.opts.transport.on((ev) => {
            if (ev.type === 'message')
                this.handleBody(ev.body);
            else if (ev.type === 'error')
                this.failActive('transport_error', ev.body);
            else if (ev.type === 'close') {
                this.failActive('transport_closed', `closed ${ev.code} ${ev.reason}`);
            }
        });
        await this.opts.transport.connect();
        // surfaceType and outpostId are what the app's tf() puts here. The server
        // acknowledges with session_established.
        this.opts.transport.send({
            type: 'session_connect',
            payload: {
                actor_id: this.opts.actorArn ?? '',
                surfaceType: this.opts.transport.surface,
                outpostId: this.opts.transport.outpostId,
            },
        });
        this.opts.transport.startAppHeartbeat();
        this.connected = true;
    }
    get threadId() {
        return this.state?.threadId ?? null;
    }
    /** Forget the thread, so the next turn starts a fresh conversation. */
    resetThread() {
        this.state = null;
    }
    /**
     * Send one user turn and stream the assistant reply.
     *
     * No `session_list` or explicit conversation creation is needed: a fresh
     * UUID thread_id is accepted and the server creates the conversation (it
     * even emits `title_generated` with the new id). That was verified end to end
     * — the model replied.
     */
    async *sendTurn(history, opts = {}) {
        if (!this.connected)
            throw new Error('session not open');
        const safeHistory = normalizeHistory(history);
        const lastUser = [...safeHistory].reverse().find((t) => t.role === 'user');
        if (!lastUser)
            throw new Error('no user turn to send');
        if (!this.state || opts.threadId) {
            this.state = { threadId: opts.threadId ?? randomUUID(), sentTurns: [] };
        }
        this.state.sentTurns.push(lastUser);
        const messageId = `msg-${randomUUID().slice(0, 8)}`;
        this.activeMessageId = messageId;
        const queue = [];
        let notify = null;
        let finished = false;
        this.activeHandler = (ev) => {
            queue.push(ev);
            if (ev.type === 'turn_end' || ev.type === 'error')
                finished = true;
            notify?.();
        };
        const mode = opts.agentMode ?? this.opts.agentMode ?? 'smart';
        const effort = clampEffort(opts.thinkingEffort ?? this.opts.thinkingEffort ?? 'high');
        this.opts.transport.send({
            type: 'user_message',
            payload: {
                thread_id: this.state.threadId,
                text: lastUser.text,
                message_id: messageId,
                // The server checks these; the app's tf() supplies them on every frame.
                surfaceType: this.opts.transport.surface,
                outpostId: this.opts.transport.outpostId,
                agent_mode: mode === 'advanced' ? 'smart' : mode,
                thinking_effort: effort,
                send_origin: 'composer',
                had_physical_input: true,
                traceId: randomUUID(),
                user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
                user_locale: 'en-US',
                auto_routing: false,
                web_search_enabled: false,
                direct_chat: false,
                ...(opts.attachments && opts.attachments.length > 0
                    ? { attachments: opts.attachments }
                    : {}),
            },
        });
        try {
            while (!finished) {
                if (queue.length === 0) {
                    await new Promise((resolve) => {
                        notify = () => {
                            notify = null;
                            resolve();
                        };
                    });
                    continue;
                }
                yield queue.shift();
            }
            while (queue.length > 0)
                yield queue.shift();
        }
        finally {
            this.activeHandler = null;
            this.activeMessageId = null;
            const reply = this.lastText;
            if (reply)
                this.state.sentTurns.push({ role: 'assistant', text: reply });
        }
    }
    lastText = '';
    /** Reasoning accumulated for the turn in flight. */
    lastThinking = '';
    /** Usage seen for the turn in flight; attached when `message_complete` lands. */
    pendingUsage = null;
    /** Ask the server to stop the in-flight turn. */
    cancel() {
        if (!this.state)
            return;
        try {
            this.opts.transport.send({
                type: 'stop_generation',
                payload: {
                    thread_id: this.state.threadId,
                    ...(this.activeMessageId ? { message_id: this.activeMessageId } : {}),
                    explicit_pause: true,
                },
            });
        }
        catch (e) {
            this.log('cancel failed', e);
        }
    }
    close() {
        this.opts.transport.terminate();
        this.connected = false;
    }
    // -------------------------------------------------------------------------
    // inbound dispatch — shapes verified against the live gateway
    // -------------------------------------------------------------------------
    handleBody(body) {
        let msg;
        try {
            msg = JSON.parse(body);
        }
        catch {
            return;
        }
        const type = typeof msg['type'] === 'string' ? msg['type'] : '';
        const payload = msg['payload'] && typeof msg['payload'] === 'object'
            ? msg['payload']
            : {};
        // Housekeeping frames: observed constantly, never part of a turn.
        if (HOUSEKEEPING_FRAME_TYPES.has(type)) {
            if (type === 'session_list') {
                this.log('session_list ignored (chat works without it)');
            }
            return;
        }
        // Server-side errors that end a turn.
        if (type === 'error') {
            const code = typeof msg['code'] === 'string' ? msg['code'] : 'error';
            const message = typeof msg['message'] === 'string' ? msg['message'] : body;
            this.deliver({ type: 'error', code, message });
            return;
        }
        switch (type) {
            case 'message_start': {
                const id = typeof msg['message_id'] === 'string' ? msg['message_id'] : this.activeMessageId ?? '';
                this.lastText = '';
                this.deliver({ type: 'message_start', messageId: id });
                return;
            }
            case 'text_delta': {
                const delta = typeof payload['delta'] === 'string' ? payload['delta'] : '';
                if (delta)
                    this.lastText += delta;
                this.deliver({ type: 'text', delta });
                return;
            }
            // Reasoning stream. VERIFIED present on the live gateway: a prompt that
            // invites extended thinking produces `thinking_start`, many
            // `thinking_delta {delta}` frames, then the answer. An earlier version of
            // this file claimed "there is NO thinking_delta in the observed chat flow"
            // and had no case for it, so every reasoning token was silently dropped —
            // the comment was a wrong inference from single-turn PONG tests, which
            // never engage thinking at all.
            case 'thinking_start': {
                this.lastThinking = '';
                this.deliver({ type: 'thinking', delta: '' });
                return;
            }
            case 'thinking_delta': {
                const delta = typeof payload['delta'] === 'string' ? payload['delta'] : '';
                if (!delta)
                    return;
                this.lastThinking += delta;
                this.deliver({ type: 'thinking', delta });
                return;
            }
            case 'thinking_complete': {
                const text = typeof payload['text'] === 'string' ? payload['text'] : this.lastThinking;
                if (text)
                    this.lastThinking = text;
                return;
            }
            case 'title_generated': {
                const title = typeof payload['title'] === 'string' ? payload['title'] : '';
                if (title)
                    this.deliver({ type: 'title', title });
                return;
            }
            case 'tool_start': {
                const toolName = typeof payload['tool_name'] === 'string' ? payload['tool_name'] : 'unknown';
                const toolId = typeof payload['tool_id'] === 'string' ? payload['tool_id'] : randomUUID();
                this.deliver({ type: 'tool_start', toolName, toolId, args: payload['arguments'] ?? null });
                return;
            }
            // `tool_result` is the verified name — the renderer's task-stream handler
            // (startup-*.js, `case 'tool_result'`) reads {tool_id, result, error,
            // status, arguments}. `tool_end` does NOT exist in this protocol; it was a
            // guess in the first version and silently matched nothing.
            case 'tool_result': {
                const toolId = typeof payload['tool_id'] === 'string' ? payload['tool_id'] : '';
                const error = typeof payload['error'] === 'string' ? payload['error'] : undefined;
                this.deliver({ type: 'tool_end', toolId, result: payload['result'] ?? null, error });
                return;
            }
            // `turn_usage` (verified name) -> our usage event. It arrives BEFORE the
            // turn is actually closed, so it reports usage but does NOT end the stream
            // — see the `message_complete` note below for why that distinction cost a
            // real bug.
            case 'turn_usage': {
                this.pendingUsage = parseUsage(payload);
                this.deliver({ type: 'usage', usage: this.pendingUsage });
                return;
            }
            // Authoritative end of a turn.
            //
            // WHY THIS ALONE CLOSES THE TURN
            // ------------------------------
            // The server sends `turn_usage` a few hundred ms before `message_complete`.
            // Ending the stream on `turn_usage` let the caller fire the NEXT turn while
            // the server was still finishing the previous one, and the server answered
            // that next message with an empty `message_complete {text:"", initiator:
            // "user"}` — an echo, not a reply. Measured on a live socket:
            //
            //   two turns back-to-back      -> 2nd reply empty
            //   three turns back-to-back    -> 2nd empty, 3rd got the 2nd's answer
            //   with a 2.5 s gap            -> both fine
            //
            // So the messages were queued, never lost, and the fix is to wait for the
            // authoritative close instead of the usage frame.
            case 'message_complete': {
                const text = typeof payload['text'] === 'string' ? payload['text'] : this.lastText;
                if (text)
                    this.lastText = text;
                this.deliver({ type: 'turn_end', usage: this.pendingUsage });
                this.pendingUsage = null;
                return;
            }
            case 'text_complete': {
                const text = typeof payload['text'] === 'string' ? payload['text'] : '';
                if (text)
                    this.lastText = text;
                return;
            }
            default:
                if (!TURN_END_FRAME_TYPES.has(type)) {
                    this.log('unhandled frame type', type);
                }
                return;
        }
    }
    deliver(ev) {
        const h = this.activeHandler;
        if (!h) {
            if (ev.type === 'error')
                this.log('error with no active turn:', ev.code, ev.message);
            return;
        }
        h(ev);
    }
    failActive(code, message) {
        const h = this.activeHandler;
        if (h)
            h({ type: 'error', code, message });
    }
}
// ---------------------------------------------------------------------------
function clampEffort(e) {
    // 'max' is capped at 'high' in the shipping build.
    return e === 'off' || e === 'low' || e === 'medium' ? e : 'high';
}
function normalizeHistory(turns) {
    const out = [];
    for (const t of turns) {
        const text = typeof t.text === 'string' ? t.text : '';
        if (!text)
            continue;
        out.push({ role: t.role === 'assistant' ? 'assistant' : 'user', text });
    }
    // Merge consecutive same-role turns: the protocol has one user turn per frame.
    const merged = [];
    for (const t of out) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === t.role)
            prev.text += `\n\n${t.text}`;
        else
            merged.push({ ...t });
    }
    return merged;
}
function parseUsage(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const u = raw;
    const num = (k) => (typeof u[k] === 'number' ? u[k] : 0);
    return {
        input: num('input_tokens'),
        output: num('output_tokens'),
        cacheRead: num('cache_read_tokens'),
        cacheWrite: num('cache_write_tokens'),
        costUsd: num('cost_usd'),
        agentHours: num('agent_hours'),
        resolvedModelId: typeof u['resolved_model_id'] === 'string' ? u['resolved_model_id'] : '',
    };
}
//# sourceMappingURL=session.js.map