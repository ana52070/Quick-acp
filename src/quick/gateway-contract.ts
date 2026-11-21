/**
 * Verified gateway behaviour — every constant here was proven against the LIVE
 * gateway, not inferred from the shipped JavaScript. Reading the renderer's
 * source gives three answers that the server actually rejects, so this file is
 * the authority for connection parameters.
 *
 * ── What was wrong in the source, and what works ──────────────────────────
 *
 * 1. OUTBOUND FRAMING
 *      renderer CUe()  : plain text utf8(JSON{eventType,payload:{payload:b64}})
 *      main  buildGatewayInputFrame() : event-stream + CBOR
 *    The renderer form is the one the server accepts for CHAT MESSAGES.
 *    With CBOR framing the socket opens and `session_connect` is acknowledged,
 *    but every later business message (session_list, user_message) is silently
 *    dropped. That asymmetry is what makes this bug so hard to see: the
 *    connection looks healthy.
 *    => USE 'json-base64'.
 *
 * 2. AUTH PLACEMENT
 *      source: Authorization: Bearer header
 *      server: query string `?token=...&surfaceType=...`
 *    A Bearer header yields 401 even with a valid token. `surfaceType` is
 *    mandatory; without it the upgrade is refused.
 *
 * 3. PATH
 *      /streaming/quickwork-chat-bidirectional-stream       -> works
 *      /ws/service/SpaceNeedleConversationService/...       -> 404
 *
 * ── Confirmed inbound frame flow for one turn ─────────────────────────────
 *
 *   message_start      {payload:{role:'assistant'}, message_id, thread_id}
 *   title_generated    {payload:{conversation_id,title}}
 *   text_delta         {payload:{delta, kernel_thread_id}}
 *   turn_usage         {payload:{input_tokens,output_tokens,cache_read_tokens,
 *                                cache_write_tokens,resolved_model_id,...}}
 *   text_complete      {payload:{text}}
 *   message_complete   {payload:{text,tool_calls,initiator}}
 *
 * `resolved_model_id` is how the caller learns WHICH model actually answered —
 * e.g. `us.anthropic.claude-opus-5-5`. The client cannot choose it.
 *
 * ── Keepalive ─────────────────────────────────────────────────────────────
 *   The server reaps the socket with
 *     {"type":"error","code":"IDLE_TIMEOUT","message":"Client sent no frames
 *      for >95 seconds"}
 *   unless a frame arrives inside that window. 45 s is safe. A `ping` sent as a
 *   plain text frame (not event-stream) also gets `{"type":"status",
 *   "payload":{"status":"pong"}}` back.
 */

/** The single path that works for a social (non-enterprise) tenant. */
export const WORKING_PATH = '/streaming/quickwork-chat-bidirectional-stream';

/** Wrong for this tenant; kept only so diagnostics can label a 404. */
export const RENDERER_PATH =
  '/ws/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream';

/**
 * Outbound framing that the server actually accepts.
 *
 * 'json-base64' = plain text frame: utf8(JSON.stringify({eventType, payload:{payload: b64}}))
 * 'cbor'        = event-stream + CBOR; opens the socket but drops business messages.
 *
 * Default changed to json-base64 after live verification.
 */
export const WORKING_FRAMING = 'json-base64' as const;

/** Server's own idle-reap threshold, from its IDLE_TIMEOUT error. */
export const SERVER_IDLE_REAP_MS = 95_000;

/** Send a keepalive comfortably inside that window. */
export const KEEPALIVE_INTERVAL_MS = 45_000;

/**
 * Build the gateway URL that opens.
 * Auth and surfaceType go in the query; no Authorization header.
 */
export function buildWorkingUrl(opts: {
  wsHost: string;
  jwt: string;
  surfaceType: string;
  outpostId?: string;
  workingSessionId?: string;
  path?: string;
}): string {
  const path = opts.path ?? WORKING_PATH;
  const params = new URLSearchParams({ surfaceType: opts.surfaceType, token: opts.jwt });
  if (opts.outpostId) params.set('outpostId', opts.outpostId);
  if (opts.workingSessionId) params.set('workingSessionId', opts.workingSessionId);
  return `wss://${opts.wsHost}${path}?${params.toString()}`;
}

/**
 * The `connected` frame belongs to the WebRTC voice path
 * (`LiveConversationWebRtcClient*`), not chat. Chat does not wait on it, so its
 * absence is not a failure.
 */
export const CONNECTED_FRAME_IS_VOICE_RELATED = true;

/**
 * Inbound types that are housekeeping, not part of a turn.
 * Kept here so the session layer does not have to hardcode the list twice.
 */
export const HOUSEKEEPING_FRAME_TYPES = new Set([
  'keepalive',
  'task_list_update',
  'runs_updated',
  'status',
  'session_established',
  'connected',
  'session_list',
]);

/**
 * Frame types that mark the end of a turn. `message_complete` is the
 * authoritative one; `text_complete` arrives just before it.
 */
export const TURN_END_FRAME_TYPES = new Set(['message_complete', 'turn_usage']);
