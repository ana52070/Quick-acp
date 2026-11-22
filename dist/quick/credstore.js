/**
 * Read the Quick session straight out of the OS credential store.
 *
 * WHY THIS REPLACES THE OUTPOST PATH
 * ----------------------------------
 * The first cut of this bridge asked the user to paste `QUICK_ACP_INSTANCE_TOKEN`
 * — the shared secret the Electron main process hands its outpost over stdin.
 * That was the wrong design: the token lives only in the app's memory, so it
 * forced a manual copy of an ephemeral value on every restart.
 *
 * The durable artifact is the LOGIN, and it is already on disk:
 *
 *   Windows Credential Manager, generic entries (verified on the target machine):
 *     Target "quickwork-social-<profileId>"          -> {"__chunks__":N,"__sha__":"..."}
 *     Target "quickwork-social-<profileId>_chunk_K"  -> one base64 fragment each
 *
 * Concatenating the chunks and base64-decoding yields a SQLite database
 * fragment holding `login_metadata`, which includes refresh_token, client_id,
 * client_secret, issuer_url, tenant_url. macOS/Linux use the same logical
 * layout behind their own keychains.
 *
 * So: read the blob, reassemble, and refresh the OIDC token ourselves. No user
 * copy-paste, no dependency on the app being open.
 */
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
// ---------------------------------------------------------------------------
// Windows credential store
// ---------------------------------------------------------------------------
const CRED_PS = (target) => `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class QwCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
"@
$ptr = [IntPtr]::Zero
if ([QwCred]::CredReadW('${target.replace(/'/g, "''")}', 1, 0, [ref]$ptr)) {
  $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][QwCred+CREDENTIAL])
  $bytes = New-Object byte[] $c.CredentialBlobSize
  [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
  # Write the raw bytes, base64-wrapped, so no console encoding can corrupt them.
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
  [QwCred]::CredFree($ptr)
}
`;
/**
 * Read one credential target. Returns the decoded blob text, or null.
 *
 * The script goes into a temp .ps1 rather than a `-Command` argument: the
 * here-string contains `@"`/`"@` and nested quotes that the Windows command
 * line mangles, which shows up as an empty read (indistinguishable from
 * "credential missing") rather than an error.
 */
async function readWindowsCredential(target) {
    const dir = await mkdtemp(join(tmpdir(), 'quick-acp-cred-'));
    const scriptPath = join(dir, 'read.ps1');
    const debug = process.env.QUICK_ACP_DEBUG === '1';
    try {
        await writeFile(scriptPath, CRED_PS(target), 'utf8');
        const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        const b64 = stdout.trim();
        if (!b64) {
            if (debug)
                console.error(`[credstore] ${target}: empty output (credential absent?)`);
            return null;
        }
        // The script prints base64 so no console encoding can corrupt the bytes.
        const raw = Buffer.from(b64, 'base64');
        const text = decodeBlob(raw);
        if (debug)
            console.error(`[credstore] ${target}: read ${raw.length} bytes`);
        return text;
    }
    catch (e) {
        // Never swallow: a broken read must be distinguishable from "not signed in".
        if (debug) {
            const err = e;
            console.error(`[credstore] ${target}: FAILED ${err.message ?? String(e)}`);
            if (err.stderr)
                console.error(`[credstore] stderr: ${err.stderr.slice(0, 400)}`);
        }
        return null;
    }
    finally {
        void rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}
/**
 * Decode one credential blob to text.
 *
 * Small entries are JSON and large ones are base64 fragments, both stored as
 * UTF-16LE — the same interleaved-NUL shape. If it is not valid utf16 we treat
 * it as utf8 rather than mangling it.
 */
function decodeBlob(buf) {
    return decodeUtf16LeIfLikely(buf) ?? buf.toString('utf8');
}
/**
 * The credential blobs are stored as UTF-16LE text. Node can decode that
 * directly, so no byte swapping is needed — swapping produces the CJK-looking
 * mojibake that made these entries look encrypted during analysis.
 */
function decodeUtf16LeIfLikely(buf) {
    if (buf.length < 2)
        return null;
    // Heuristic: for ASCII-range utf16 text the odd bytes are 0x00. A big-endian
    // blob would have the zeroes at the even offsets instead, so check both.
    let zeroOdd = 0;
    let zeroEven = 0;
    const sample = Math.min(buf.length, 512);
    const pairs = Math.floor(sample / 2);
    for (let i = 0; i < pairs; i++) {
        if (buf[i * 2 + 1] === 0)
            zeroOdd++;
        if (buf[i * 2] === 0)
            zeroEven++;
    }
    if (pairs === 0)
        return null;
    if (zeroOdd / pairs >= 0.6) {
        return buf.toString('utf16le').replace(/\0+$/, '');
    }
    if (zeroEven / pairs >= 0.6) {
        // Big-endian UTF-16: swap into little-endian first.
        const swapped = Buffer.from(buf);
        swapped.swap16();
        return swapped.toString('utf16le').replace(/\0+$/, '');
    }
    return null;
}
function quickworkHome() {
    return process.env.QUICK_ACP_QUICKWORK_HOME ?? join(homedir(), '.quickwork');
}
function readProfiles() {
    const path = join(quickworkHome(), 'profiles.json');
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
/** Pick the active profile, or the only one. */
export function activeProfileId() {
    const profiles = readProfiles();
    if (!profiles?.entries?.length)
        return null;
    if (profiles.last_active) {
        const hit = profiles.entries.find((e) => e.id === profiles.last_active);
        if (hit)
            return hit.id;
    }
    return profiles.entries[0]?.id ?? null;
}
/** Read the tenant/issuer/client hints the profile records in the clear. */
export function profileHints() {
    const profiles = readProfiles();
    if (!profiles?.entries?.length)
        return null;
    const id = activeProfileId();
    const entry = profiles.entries.find((e) => e.id === id) ?? profiles.entries[0];
    return entry?.login_metadata ?? null;
}
// ---------------------------------------------------------------------------
// Reassemble the login from the chunked credential
// ---------------------------------------------------------------------------
/**
 * Parse the credential envelope: {"__chunks__":N,"__sha__":"..."} — the real
 * payload is spread across N sibling entries.
 */
function parseChunkEnvelope(text) {
    try {
        const parsed = JSON.parse(text);
        const chunks = parsed['__chunks__'];
        const sha = parsed['__sha__'];
        if (typeof chunks === 'number' && chunks > 0) {
            return { chunks, sha: typeof sha === 'string' ? sha : '' };
        }
    }
    catch {
        // Not an envelope; maybe a direct payload.
    }
    return null;
}
/**
 * Pull login_metadata out of the assembled chunk text.
 *
 * The reassembled bytes are a SQLite page (or a fragment of one) whose cell
 * payload is the JSON we want, so this scans rather than assuming a document
 * shape. Two forms occur in practice and both are handled:
 *
 *   - chunk 0 carries the JSON text directly: {"refresh_token": "..."}
 *   - later chunks carry base64 fragments of further page content
 *
 * Because the JSON is embedded in binary, quoting may appear escaped (\").
 */
function extractLoginMetadata(blob) {
    // Normalise escaped quotes so the same scanner finds JSON in either form.
    const candidates = [blob, blob.replace(/\\"/g, '"')];
    for (const text of candidates) {
        // Fast path: the whole thing is JSON.
        const direct = tryJsonObject(text.trim());
        if (direct && looksLikeLogin(direct))
            return direct;
    }
    for (const text of candidates) {
        const parsed = scanForJsonWith(text, 'refresh_token');
        if (parsed)
            return parsed;
        const alt = scanForJsonWith(text, 'access_token');
        if (alt)
            return alt;
        const alt2 = scanForJsonWith(text, 'client_id');
        if (alt2)
            return alt2;
    }
    return null;
}
/** Find the smallest enclosing JSON object containing `marker`. */
function scanForJsonWith(text, marker) {
    const needle = `"${marker}"`;
    let from = 0;
    while (true) {
        const at = text.indexOf(needle, from);
        if (at < 0)
            return null;
        from = at + 1;
        const start = text.lastIndexOf('{', at);
        if (start < 0)
            continue;
        const end = matchBrace(text, start);
        if (end < 0)
            continue;
        const obj = tryJsonObject(text.slice(start, end + 1));
        if (obj && looksLikeLogin(obj))
            return obj;
    }
}
function tryJsonObject(text) {
    const candidates = [text, sanitizeJsonControlChars(text)];
    for (const candidate of candidates) {
        try {
            const v = JSON.parse(candidate);
            if (v && typeof v === 'object' && !Array.isArray(v))
                return v;
        }
        catch {
            /* try the next form */
        }
    }
    return null;
}
/**
 * Strip control characters that SQLite page padding leaves inside the JSON.
 *
 * Two adjacent pages concatenate in the middle of a string literal, so the
 * recovered text has raw bytes (0x00-0x1f) where the page boundary was. JSON
 * forbids those unescaped, and they carry no information we need.
 */
function sanitizeJsonControlChars(text) {
    // Fast path: already clean.
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
        return text;
    const schema = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
    // Decode JSON escaped backslashes first so the scanner is not thrown off.
    return text.replace(schema, '');
}
function looksLikeLogin(obj) {
    return (typeof obj.refresh_token === 'string' ||
        typeof obj.access_token === 'string' ||
        typeof obj.client_id === 'string');
}
/** Find the index of the brace closing the object opened at `start`. */
function matchBrace(text, start) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (ch === '\\') {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (ch === '{')
            depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    return -1;
}
/**
 * Read the stored login for the active profile.
 *
 * Returns null with a reason rather than throwing, so the caller can decide
 * between falling back to the outpost or asking the user to sign in.
 */
export async function readStoredLogin() {
    const profileId = activeProfileId();
    if (!profileId) {
        return { ok: false, reason: `no Quick profile found under ${quickworkHome()}/profiles.json` };
    }
    if (process.platform !== 'win32') {
        // macOS/Linux keychains are readable via `security` / `secret-tool`; not
        // implemented yet, so fail with the concrete next step instead of guessing.
        return {
            ok: false,
            reason: `automatic credential read is implemented for Windows only. ` +
                `On ${process.platform}, sign in to Quick and set QUICK_ACP_INSTANCE_TOKEN, ` +
                `or provide QUICK_ACP_REFRESH_TOKEN manually.`,
        };
    }
    const targets = [
        `quickwork-social-${profileId}`,
        `quickwork-enterprise-${profileId}`,
        `quickwork-${profileId}`,
    ];
    for (const rawTarget of targets) {
        // CredReadW takes the BARE target name. `cmdkey /list` prints it prefixed
        // with "LegacyGeneric:target=", but that prefix is a display form, not part
        // of the name — passing it makes the lookup fail with ERROR_NOT_FOUND.
        const head = await readWindowsCredential(rawTarget);
        if (!head)
            continue;
        const envelope = parseChunkEnvelope(head);
        if (!envelope) {
            const direct = extractLoginMetadata(head);
            if (direct)
                return { ok: true, login: direct, source: `${rawTarget} (single entry)` };
            continue;
        }
        const parts = [];
        // Chunk suffixes are ZERO-based: "__chunks__": 2 means _chunk_0 and
        // _chunk_1. Starting at 1 silently drops the first fragment.
        for (let i = 0; i < envelope.chunks; i++) {
            const chunk = await readWindowsCredential(`${rawTarget}_chunk_${i}`);
            if (!chunk) {
                return {
                    ok: false,
                    reason: `credential "${rawTarget}" reports ${envelope.chunks} chunk(s) but ` +
                        `chunk ${i} is missing or unreadable`,
                };
            }
            parts.push(expandChunk(chunk));
        }
        // Join with NO separator: the chunks are consecutive fragments of one
        // page stream, and a newline here lands inside a JSON string literal,
        // which is illegal JSON and makes the whole payload unparsable.
        const login = extractLoginMetadata(parts.join(''));
        if (login) {
            return { ok: true, login, source: `${rawTarget} (${envelope.chunks} chunk(s))` };
        }
        return {
            ok: false,
            reason: `read ${envelope.chunks} chunk(s) from "${rawTarget}" but found no login_metadata. ` +
                'The entry may be encrypted or the format changed.',
        };
    }
    return {
        ok: false,
        reason: `no Quick credential found for profile "${profileId}". ` +
            'Sign in to the Quick desktop app once, then retry.',
    };
}
/**
 * Normalise one chunk body.
 *
 * A chunk is a fragment of a SQLite page. The interesting JSON is usually
 * present as PLAIN TEXT inside the page, but the tail of a page is often
 * another base64 blob, so the same chunk can contain both. We therefore return
 * the original text AND, when the tail decodes to text, that too — the scanner
 * then searches all of it.
 */
function expandChunk(text) {
    const out = [text];
    const cleaned = text.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length >= 16) {
        try {
            const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
            const printable = decoded.replace(/[^\x20-\x7e\r\n\t]/g, '');
            if (printable.length >= decoded.length * 0.8)
                out.push(decoded);
        }
        catch {
            /* keep the raw text */
        }
    }
    return out.join('\n');
}
/** Synchronous convenience for diagnostics that only need to know it is there. */
export function credentialTargetsExistSync() {
    if (process.platform !== 'win32')
        return [];
    const profileId = activeProfileId();
    if (!profileId)
        return [];
    try {
        const out = execFileSync('cmdkey', ['/list'], { encoding: 'utf8', windowsHide: true });
        return out
            .split('\n')
            .filter((l) => l.includes(`quickwork-`) && l.includes(profileId))
            .map((l) => l.trim());
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=credstore.js.map