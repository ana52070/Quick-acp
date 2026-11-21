/**
 * Quick gateway wire codec.
 *
 * Two independent facts were recovered from the shipped build, and they
 * DISAGREE with each other. Both are reproduced here and the choice is a
 * runtime option, because the evidence does not establish which one the
 * server accepts today.
 *
 *   A) Main process  (dist/main/gatewayBidiCodec.js) 鈥?used by the IPC proxy
 *      path, which is the default in the shipping build because a browser
 *      WebSocket cannot set an Authorization header.
 *        send:    event-stream{ :event-type=rawInputEvent,
 *                               :content-type=application/cbor,
 *                               :message-type=event }
 *                 payload = CBOR({ payload: <utf8 bytes of json> })
 *        receive: event-stream payload = CBOR({ payload: <utf8 bytes> })
 *
 *   B) Renderer  (startup-*.js, functions CUe / EUe) 鈥?used by the direct
 *      browser WebSocket path.
 *        send:    PLAIN TEXT (no event-stream at all)
 *                 utf8( JSON.stringify({ eventType: "rawInputEvent",
 *                                        payload: { payload: <base64> } }) )
 *        receive: event-stream payload = utf8 JSON { payload: <base64 string> }
 *                 -> base64 decode -> utf8 -> inner json
 *
 * A is symmetric CBOR; B is symmetric JSON/base64. They are not two views of
 * one format. `mode` selects which framing this client speaks.
 */

const _enc = new TextEncoder();
const _dec = new TextDecoder();

// ---------------------------------------------------------------------------
// CBOR (only the shapes this protocol uses)
// ---------------------------------------------------------------------------

function cborHead(major: number, n: number, out: number[]): void {
  const mt = major << 5;
  if (n < 24) out.push(mt | n);
  else if (n < 0x100) out.push(mt | 24, n);
  else if (n < 0x10000) out.push(mt | 25, (n >> 8) & 0xff, n & 0xff);
  else if (n < 0x100000000) out.push(mt | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  else {
    const hi = Math.floor(n / 0x100000000);
    const lo = n >>> 0;
    out.push(
      mt | 27,
      (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    );
  }
}

function cborEncInto(v: unknown, out: number[]): void {
  if (v === null || v === undefined) out.push(0xf6);
  else if (v === true) out.push(0xf5);
  else if (v === false) out.push(0xf4);
  else if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 0 && v < 2 ** 53) cborHead(0, v, out);
    else if (Number.isInteger(v) && v < 0 && v > -(2 ** 53)) cborHead(1, -1 - v, out);
    else {
      out.push(0xfb);
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, v, false);
      for (const b of new Uint8Array(buf)) out.push(b);
    }
  } else if (v instanceof Uint8Array) {
    cborHead(2, v.length, out);
    for (const b of v) out.push(b);
  } else if (typeof v === 'string') {
    const b = _enc.encode(v);
    cborHead(3, b.length, out);
    for (const x of b) out.push(x);
  } else if (Array.isArray(v)) {
    cborHead(4, v.length, out);
    for (const item of v) cborEncInto(item, out);
  } else if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    cborHead(5, entries.length, out);
    for (const [k, val] of entries) {
      cborEncInto(k, out);
      cborEncInto(val, out);
    }
  } else {
    throw new TypeError(`cannot CBOR-encode ${typeof v}`);
  }
}

export function cborEncode(value: unknown): Uint8Array {
  const out: number[] = [];
  cborEncInto(value, out);
  return new Uint8Array(out);
}

type Cbor = unknown;

function cborDecodeAt(data: Uint8Array, start: number): [Cbor, number] {
  let i = start;
  const ib = data[i++]!;
  const major = ib >> 5;
  const ai = ib & 0x1f;

  if (major === 7) {
    if (ai === 20) return [false, i];
    if (ai === 21) return [true, i];
    if (ai === 22 || ai === 23) return [null, i];
    if (ai === 25) {
      const h = (data[i]! << 8) | data[i + 1]!;
      i += 2;
      const sign = h & 0x8000 ? -1 : 1;
      const exp = (h >> 10) & 0x1f;
      const mant = h & 0x3ff;
      if (exp === 0) return [sign * mant * 2 ** -24, i];
      if (exp === 31) return [mant === 0 ? sign * Infinity : NaN, i];
      return [sign * (1024 + mant) * 2 ** (exp - 25), i];
    }
    if (ai === 26) return [new DataView(data.buffer, data.byteOffset + i, 4).getFloat32(0, false), i + 4];
    if (ai === 27) return [new DataView(data.buffer, data.byteOffset + i, 8).getFloat64(0, false), i + 8];
    return [null, i];
  }

  let n: number | null;
  if (ai < 24) n = ai;
  else if (ai === 24) { n = data[i++]!; }
  else if (ai === 25) { n = (data[i]! << 8) | data[i + 1]!; i += 2; }
  else if (ai === 26) {
    n = ((data[i]! << 24) | (data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!) >>> 0;
    i += 4;
  } else if (ai === 27) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = v * 256 + data[i + k]!;
    n = v;
    i += 8;
  } else if (ai === 31) {
    n = null;
  } else {
    throw new Error('reserved CBOR additional-info');
  }

  if (major === 0) return [n, i];
  if (major === 1) return [-1 - (n as number), i];

  if (major === 2) {
    if (n === null) {
      const chunks: number[] = [];
      while (data[i] !== 0xff) {
        const [c, ni] = cborDecodeAt(data, i);
        chunks.push(...(c as Uint8Array));
        i = ni;
      }
      return [new Uint8Array(chunks), i + 1];
    }
    const out = data.slice(i, i + n);
    return [out, i + n];
  }

  if (major === 3) {
    if (n === null) {
      let s = '';
      while (data[i] !== 0xff) {
        const [c, ni] = cborDecodeAt(data, i);
        s += c as string;
        i = ni;
      }
      return [s, i + 1];
    }
    return [_dec.decode(data.slice(i, i + n)), i + n];
  }

  if (major === 4) {
    const arr: Cbor[] = [];
    if (n === null) {
      while (data[i] !== 0xff) {
        const [v, ni] = cborDecodeAt(data, i);
        arr.push(v);
        i = ni;
      }
      return [arr, i + 1];
    }
    for (let k = 0; k < n; k++) {
      const [v, ni] = cborDecodeAt(data, i);
      arr.push(v);
      i = ni;
    }
    return [arr, i];
  }

  if (major === 5) {
    const obj: Record<string, Cbor> = {};
    if (n === null) {
      while (data[i] !== 0xff) {
        const [k, ki] = cborDecodeAt(data, i);
        const [v, vi] = cborDecodeAt(data, ki);
        obj[String(k)] = v;
        i = vi;
      }
      return [obj, i + 1];
    }
    for (let k = 0; k < n; k++) {
      const [key, ki] = cborDecodeAt(data, i);
      const [val, vi] = cborDecodeAt(data, ki);
      obj[String(key)] = val;
      i = vi;
    }
    return [obj, i];
  }

  if (major === 6) {
    const [v, ni] = cborDecodeAt(data, i);
    return [v, ni];
  }

  throw new Error(`bad CBOR major type ${major}`);
}

export function cborDecode(data: Uint8Array): Cbor {
  const [v] = cborDecodeAt(data, 0);
  return v;
}

// ---------------------------------------------------------------------------
// AWS event-stream framing
// [total_len:4][headers_len:4][prelude_crc:4][headers][payload][msg_crc:4]
// big-endian; CRC32 zlib-compatible.
//
// Header entry format (NOT CBOR): [name_len:1][name][value_type:1][value]
// value_type 7 = string -> [len:2][utf8]
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const HV_STRING = 7;

export function esEncode(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const hb: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nb = _enc.encode(name);
    if (nb.length > 255) throw new Error(`event-stream header name too long: ${name}`);
    hb.push(nb.length);
    for (const b of nb) hb.push(b);
    hb.push(HV_STRING);
    const vb = _enc.encode(value);
    hb.push((vb.length >> 8) & 0xff, vb.length & 0xff);
    for (const b of vb) hb.push(b);
  }
  const headersLen = hb.length;
  const totalLen = 12 + headersLen + payload.length + 4;
  const msg = new Uint8Array(totalLen);
  const view = new DataView(msg.buffer);
  view.setUint32(0, totalLen, false);
  view.setUint32(4, headersLen, false);
  view.setUint32(8, crc32(msg.slice(0, 8)), false);
  msg.set(new Uint8Array(hb), 12);
  msg.set(payload, 12 + headersLen);
  view.setUint32(totalLen - 4, crc32(msg.slice(0, totalLen - 4)), false);
  return msg;
}

export interface EsMessage {
  headers: Record<string, unknown>;
  payload: Uint8Array;
}

export function esDrain(buffer: Uint8Array, offset = 0): { messages: EsMessage[]; consumed: number } {
  const messages: EsMessage[] = [];
  let pos = offset;
  while (pos + 16 <= buffer.length) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + pos);
    const totalLen = view.getUint32(0, false);
    const headersLen = view.getUint32(4, false);
    if (totalLen < 16 || totalLen > 16 * 1024 * 1024) {
      // Not a frame boundary we trust; step one byte like the app does.
      pos += 1;
      continue;
    }
    if (pos + totalLen > buffer.length) break; // incomplete
    const hstart = pos + 12;
    const hend = hstart + headersLen;
    if (hend > buffer.length) break;
    const hend_ = pos + totalLen - 4;
    if (hend_ < hend) break;
    const payload = buffer.slice(hend, hend_);
    let ok = true;
    try {
      const hs = _decodeHeaders(buffer, hstart, hend);
      messages.push({ headers: hs, payload });
    } catch {
      ok = false;
    }
    if (!ok) pos += 1;
    else pos += totalLen;
  }
  return { messages, consumed: pos - offset };
}

function _decodeHeaders(buffer: Uint8Array, start: number, end: number): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  let j = start;
  while (j < end) {
    const nl = buffer[j++]!;
    const name = _dec.decode(buffer.slice(j, j + nl));
    j += nl;
    const vt = buffer[j++]!;
    if (vt === 0) headers[name] = true;
    else if (vt === 1) headers[name] = false;
    else if (vt === 2) { headers[name] = buffer[j]; j += 1; }
    else if (vt === 3) { headers[name] = (buffer[j]! << 8) | buffer[j + 1]!; j += 2; }
    else if (vt === 4) { headers[name] = new DataView(buffer.buffer, buffer.byteOffset + j, 4).getUint32(0, false); j += 4; }
    else if (vt === 5) { let v = 0; for (let k = 0; k < 8; k++) v = v * 256 + buffer[j + k]!; headers[name] = v; j += 8; }
    else if (vt === 6) { const bl = (buffer[j]! << 8) | buffer[j + 1]!; j += 2; headers[name] = buffer.slice(j, j + bl); j += bl; }
    else if (vt === 7) { const vl = (buffer[j]! << 8) | buffer[j + 1]!; j += 2; headers[name] = _dec.decode(buffer.slice(j, j + vl)); j += vl; }
    else if (vt === 8) { let v = 0; for (let k = 0; k < 8; k++) v = v * 256 + buffer[j + k]!; headers[name] = v; j += 8; }
    else if (vt === 9) { headers[name] = buffer.slice(j, j + 16); j += 16; }
    else throw new Error(`unknown event-stream header value type ${vt}`);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Quick protocol framing
// ---------------------------------------------------------------------------

export type FramingMode = 'cbor' | 'json-base64';

/**
 * Framing the live gateway accepts for CHAT messages.
 *
 * 'cbor' opens the socket and gets session_connect acknowledged, but every
 * later business message (session_list, user_message) is silently dropped —
 * verified on the target tenant. Default is json-base64.
 */
export const DEFAULT_FRAMING: FramingMode = 'json-base64';

/**
 * Encode one outbound Quick JSON message into the bytes to put on the socket.
 *
 * mode 'cbor' (main-process / IPC proxy path, the shipping default):
 *   event-stream with :event-type=rawInputEvent carrying CBOR({payload: bytes})
 * mode 'json-base64' (renderer direct-WebSocket path):
 *   PLAIN TEXT utf8(JSON({eventType, payload:{payload: base64}}))
 */
export function encodeOutbound(jsonMessage: string, mode: FramingMode = DEFAULT_FRAMING): Uint8Array {
  if (mode === 'cbor') {
    const inner = cborEncode({ payload: _enc.encode(jsonMessage) });
    return esEncode(
      {
        ':event-type': 'rawInputEvent',
        ':content-type': 'application/cbor',
        ':message-type': 'event',
      },
      inner,
    );
  }
  const b64 = Buffer.from(_enc.encode(jsonMessage)).toString('base64');
  return _enc.encode(JSON.stringify({ eventType: 'rawInputEvent', payload: { payload: b64 } }));
}

export type InboundEvent =
  | { kind: 'error'; code: string; body: string }
  | { kind: 'message'; body: string }
  | { kind: 'ignored'; reason: string };

/**
 * Decode inbound event-stream payloads into inner JSON strings.
 * Handles both the CBOR payload (main) and JSON+base64 payload (renderer).
 */
export function decodeInbound(msg: EsMessage, mode: FramingMode = DEFAULT_FRAMING): InboundEvent {
  const mt = msg.headers[':message-type'];
  if (mt === 'error' || mt === 'exception') {
    const code = String(
      (msg.headers[':error-code'] as string) ??
      (msg.headers[':exception-type'] as string) ??
      'unknown',
    );
    let reason = String((msg.headers[':error-message'] as string) ?? '');
    if (!reason && msg.payload.length > 0) {
      try {
        const text = _dec.decode(msg.payload);
        const parsed = JSON.parse(text) as { message?: unknown; Message?: unknown };
        const m = parsed?.message ?? parsed?.Message;
        reason = typeof m === 'string' && m ? m : text;
      } catch {
        reason = _dec.decode(msg.payload);
      }
    }
    return { kind: 'error', code, body: `[${code}] ${reason}`.trim() };
  }

  if (msg.payload.length === 0) return { kind: 'ignored', reason: 'empty-payload' };

  // Try CBOR first: the shipping default. Falls through to JSON+base64.
  const order: FramingMode[] = mode === 'cbor' ? ['cbor', 'json-base64'] : ['json-base64', 'cbor'];
  for (const attempt of order) {
    const json = attempt === 'cbor' ? _tryCborPayload(msg.payload) : _tryJsonBase64Payload(msg.payload);
    if (json !== null) return { kind: 'message', body: json };
  }
  return { kind: 'ignored', reason: 'unrecognized-payload' };
}

function _tryCborPayload(payload: Uint8Array): string | null {
  let decoded: unknown;
  try {
    decoded = cborDecode(payload);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object') return null;
  const inner = (decoded as Record<string, unknown>)['payload'];
  let json: string | null = null;
  if (inner instanceof Uint8Array) json = _dec.decode(inner);
  else if (typeof inner === 'string') json = inner;
  if (json === null) return null;
  return _looksLikeJson(json) ? json : null;
}

function _tryJsonBase64Payload(payload: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(_dec.decode(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const b64 = (parsed as Record<string, unknown>)['payload'];
  if (typeof b64 !== 'string') return null;
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return _looksLikeJson(json) ? json : null;
  } catch {
    return null;
  }
}

function _looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

