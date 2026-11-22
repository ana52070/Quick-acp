/**
 * Quick session acquisition.
 *
 * THREE SOURCES, IN ORDER OF PREFERENCE
 * -------------------------------------
 * 1. Cached session (in memory, until the token nears expiry).
 * 2. Refresh it ourselves (oidc.ts) when a stored login exists. This WORKS —
 *    an earlier note in this file claimed it did not, and that was wrong. The
 *    two real mistakes were the host (`oidc.<region>.api.aws`, not
 *    `.amazonaws.com`) and putting the client secret in the body instead of
 *    HTTP Basic. Both are fixed and verified live.
 * 3. Ask Quick's own outpost (auth.ts `startOutpost` + `/auth/sncs-session`).
 *    Needed not for the token but for what the token does not carry:
 *    `ws_host`, `actor_arn`, `tenant_url`.
 *
 * A machine that has never run the desktop app has no stored login. For that
 * case `login.ts` performs the full OAuth authorization-code + PKCE flow in a
 * browser and writes a `profiles.json` the outpost accepts, so the outpost can
 * be started against a home directory that this bridge created.
 *
 * The outpost's /auth/sncs-session needs the instance token, which the app
 * holds in memory. `startOutpost()` handles the supported way to get one.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { activeProfileId, readStoredLogin } from './credstore.js';
import { jwtExpiry } from './oidc.js';
/**
 * Path used for a new session.
 *
 * VERIFIED: the working path for this tenant family is
 * `/streaming/quickwork-chat-bidirectional-stream`. The
 * `/ws/service/SpaceNeedleConversationService/...` form 404s.
 */
export const DEFAULT_WS_PATH = '/streaming/quickwork-chat-bidirectional-stream';
/** The renderer's path constant; 404s here, kept for diagnostics. */
export const ALT_WS_PATH = '/ws/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream';
export function surfaceForPlatform(platform = process.platform) {
    return platform === 'win32' ? 'QUICK_WORK_DESKTOP_WINDOWS' : 'QUICK_WORK_DESKTOP_MAC';
}
/** Read the outpost port the app uses. Observed default 8780. */
export function outpostPort() {
    const raw = process.env.QUICKWORK_OUTPOST_PORT ?? '8780';
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 8780;
}
export function quickworkHome() {
    return process.env.QUICK_ACP_QUICKWORK_HOME ?? join(homedir(), '.quickwork');
}
// ---------------------------------------------------------------------------
// Session cache
// ---------------------------------------------------------------------------
let cached = null;
/** Refresh this long before expiry so a token never dies mid-turn. */
const EXPIRY_SKEW_MS = 120_000;
function cachedIsFresh(s) {
    if (!s)
        return false;
    if (s.expiresAt === null)
        return true; // unknown expiry: trust until the server says no
    return Date.now() + EXPIRY_SKEW_MS < s.expiresAt;
}
export function clearSessionCache() {
    cached = null;
}
function hostFromTenantUrl(tenantUrl) {
    try {
        return new URL(tenantUrl).host;
    }
    catch {
        return tenantUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }
}
/** The profile's device id, which is the closest durable outpost identity. */
function readDeviceId() {
    const id = activeProfileId();
    if (!id)
        return '';
    try {
        return readFileSync(join(quickworkHome(), 'profiles', id, 'device_id'), 'utf8').trim();
    }
    catch {
        return '';
    }
}
// ---------------------------------------------------------------------------
// Outpost: the supported token source
// ---------------------------------------------------------------------------
/** Is something listening on the outpost port and answering /health? */
export async function outpostIsUp() {
    try {
        const resp = await fetch(`http://127.0.0.1:${outpostPort()}/health`, {
            signal: AbortSignal.timeout(1_500),
        });
        return resp.ok;
    }
    catch {
        return false;
    }
}
async function sessionFromOutpost() {
    const token = process.env.QUICK_ACP_INSTANCE_TOKEN;
    if (!token)
        return null;
    const url = `http://localhost:${outpostPort()}/auth/sncs-session`;
    let resp;
    try {
        resp = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
        });
    }
    catch {
        return null;
    }
    if (!resp.ok)
        return null;
    let body;
    try {
        body = (await resp.json());
    }
    catch {
        return null;
    }
    const jwt = typeof body['id_token'] === 'string' ? body['id_token'] : '';
    const wsHost = typeof body['ws_host'] === 'string' ? body['ws_host'] : '';
    if (!jwt || !wsHost)
        return null;
    const tenantUrl = typeof body['tenant_url'] === 'string' && body['tenant_url']
        ? body['tenant_url']
        : `https://${wsHost}`;
    return {
        jwt,
        wsHost,
        wsPath: typeof body['ws_path'] === 'string' && body['ws_path'] ? body['ws_path'] : DEFAULT_WS_PATH,
        tenantUrl,
        surface: surfaceForPlatform(),
        outpostId: typeof body['outpost_device_id'] === 'string' ? body['outpost_device_id'] : readDeviceId(),
        workingSessionId: typeof body['working_session_id'] === 'string'
            ? body['working_session_id']
            : randomUUID(),
        actorArn: typeof body['actor_arn'] === 'string' ? body['actor_arn'] : '',
        provider: typeof body['provider'] === 'string' ? body['provider'] : '',
        source: 'outpost',
        expiresAt: jwtExpiry(jwt),
    };
}
/**
 * Locate the bundled agent binary the app would run as its outpost.
 * Returns null when the install layout is not recognised.
 */
export function findAgentBinary() {
    const explicit = process.env.QUICK_ACP_AGENT_BIN;
    if (explicit && existsSync(explicit))
        return explicit;
    const candidates = [
        // The path this app uses on Windows.
        join(process.env['LOCALAPPDATA'] ?? '', 'quickwork', 'agent', 'quickwork-agent.exe'),
        join(homedir(), 'AppData', 'Local', 'quickwork', 'agent', 'quickwork-agent.exe'),
        // A caller-supplied install root.
        join(process.env['QUICK_ACP_QUICKWORK_DIR'] ?? '', 'resources', 'agent.zip'),
    ];
    for (const c of candidates) {
        if (c && existsSync(c) && c.endsWith('.exe'))
            return c;
    }
    return null;
}
/**
 * Start the app's own outpost so it refreshes the login for us.
 *
 * The outpost reads the instance token from STDIN as its first line (the app
 * does exactly this: `process.stdin.write(token + '\n')`). We mint the token
 * ourselves 鈥?it is a shared secret between us and the child, so we get to
 * choose it 鈥?then hand the same value to /auth/sncs-session.
 *
 * This is the supported path: it uses the app's own signed binary, its own
 * stored login, and its own refresh logic. No credential re-implementation.
 */
export async function startOutpost(opts = {}) {
    if (await outpostIsUp()) {
        const existing = process.env.QUICK_ACP_INSTANCE_TOKEN;
        return {
            started: true,
            instanceToken: existing ?? null,
            reason: existing
                ? 'an outpost is already running and QUICK_ACP_INSTANCE_TOKEN is set'
                : 'an outpost is already running but we do not know its instance token; ' +
                    'set QUICK_ACP_INSTANCE_TOKEN, or stop the app and let this bridge start its own outpost',
        };
    }
    const bin = findAgentBinary();
    if (!bin) {
        return {
            started: false,
            instanceToken: null,
            reason: 'could not find quickwork-agent.exe. Set QUICK_ACP_AGENT_BIN to its full path ' +
                '(usually %LOCALAPPDATA%\\quickwork\\agent\\quickwork-agent.exe).',
        };
    }
    // We choose the token; the child authenticates its callers with it.
    const token = randomBytes(32).toString('hex');
    const child = spawn(bin, ['--outpost-only', '--manifest', 'desktop', '--port', String(outpostPort())], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
        env: {
            ...process.env,
            QUICKWORK_OUTPOST_PORT: String(outpostPort()),
            // The app always injects the build stage; without it the bundled agent
            // aborts in get_profile_stage with
            // "QUICKWORK_BUILD_STAGE is not set". prod matches the shipping build.
            QUICKWORK_BUILD_STAGE: process.env.QUICKWORK_BUILD_STAGE ?? 'prod',
            QUICKWORK_CLOUD_MODE: process.env.QUICKWORK_CLOUD_MODE ?? '1',
        },
    });
    // First line on stdin is the instance token, as the app does.
    try {
        child.stdin?.write(`${token}\n`);
    }
    catch {
        /* the child will exit and we report below */
    }
    let stderrTail = '';
    child.stderr?.on('data', (c) => {
        stderrTail = (stderrTail + c.toString('utf8')).slice(-2000);
    });
    // Keep the process alive for the lifetime of this agent; do not leak it.
    const cleanup = () => {
        try {
            child.kill();
        }
        catch {
            /* already gone */
        }
    };
    process.once('exit', cleanup);
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    const deadline = Date.now() + (opts.waitMs ?? 120_000);
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            return {
                started: false,
                instanceToken: null,
                reason: `the outpost exited with code ${child.exitCode}.` +
                    (stderrTail ? ` Its stderr: ${stderrTail.slice(-400)}` : ''),
            };
        }
        if (await outpostIsUp()) {
            process.env.QUICK_ACP_INSTANCE_TOKEN = token;
            return { started: true, instanceToken: token };
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    cleanup();
    return {
        started: false,
        instanceToken: null,
        reason: `the outpost did not become healthy within ${opts.waitMs ?? 120_000}ms`,
    };
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Resolve a usable session.
 *
 * Order of preference:
 *   1. cached (until near expiry)
 *   2. the stored login, refreshed by us   (session-direct.ts — no outpost needed)
 *   3. the app's outpost                    (needs its instance token)
 *
 * Direct first is deliberate: it works without the desktop app running, without
 * an instance token, and without the 93 MB agent binary — verified end to end
 * against the live gateway. The outpost stays as a fallback for deployments
 * whose login blob lacks `tenant_url`.
 *
 * `force` bypasses the in-memory cache, which a token refresh needs.
 */
export async function resolveSession(opts = {}) {
    if (!opts.force && cachedIsFresh(cached)) {
        return cached;
    }
    if (process.env.QUICK_ACP_MOCK_SESSION === '1') {
        return {
            jwt: 'mock-jwt-token',
            wsHost: process.env.QUICK_ACP_MOCK_HOST || '127.0.0.1:8781',
            wsPath: process.env.QUICK_ACP_MOCK_PATH || DEFAULT_WS_PATH,
            tenantUrl: 'http://127.0.0.1',
            surface: surfaceForPlatform(),
            outpostId: 'mock-device-id',
            workingSessionId: randomUUID(),
            actorArn: 'arn:aws:quick::123456789012:actor/mock',
            provider: 'mock',
            source: 'cached',
            expiresAt: Date.now() + 3600_000,
        };
    }
    const failures = [];
    // 1. Straight from the credential store: no outpost, no instance token.
    try {
        const { sessionDirect } = await import('./session-direct.js');
        const direct = await sessionDirect();
        if (direct.ok && direct.session) {
            cached = direct.session;
            return direct.session;
        }
        failures.push(`stored login: ${direct.reason}`);
    }
    catch (e) {
        failures.push(`stored login: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 2. The app's outpost.
    try {
        const s = await sessionFromOutpost();
        if (s) {
            cached = s;
            return s;
        }
        if (process.env.QUICK_ACP_INSTANCE_TOKEN) {
            failures.push('outpost: it did not return a usable session');
        }
        else {
            failures.push('outpost: QUICK_ACP_INSTANCE_TOKEN is not set, so its session route refuses us');
        }
    }
    catch (e) {
        failures.push(`outpost: ${e instanceof Error ? e.message : String(e)}`);
    }
    const profile = activeProfileId();
    const stored = await readStoredLogin();
    throw new Error([
        'Could not obtain a Quick session.',
        '',
        ...failures.map((f) => `  - ${f}`),
        '',
        profile
            ? `Profile "${profile}" exists and its login is ${stored.ok ? 'READABLE' : 'NOT readable'}.`
            : `No Quick profile found under ${quickworkHome()}.`,
        '',
        'How to fix:',
        '  A. Quick desktop app signed in at least once? Then just let this bridge start',
        '     the outpost:',
        '       node dist/doctor.js --start-outpost',
        '  B. No Quick install at all? Sign in without it:',
        '       node dist/login-cli.js --start-url https://ssoins-xxxxx.awsapps.com/start',
        '     (the address of your AWS access portal; see README "没有官方客户端也能登录")',
    ].join('\n'));
}
/** Report what credentials are discoverable, without revealing any secret. */
export async function describeCredentialState() {
    const profile = activeProfileId();
    const state = {
        platform: process.platform,
        quickworkHome: quickworkHome(),
        activeProfile: profile,
        outpostPort: outpostPort(),
        outpostUp: await outpostIsUp(),
        agentBinary: findAgentBinary(),
        hasInstanceTokenEnv: Boolean(process.env.QUICK_ACP_INSTANCE_TOKEN),
    };
    const read = await readStoredLogin();
    if (read.ok) {
        const exp = read.login['access_token_expiry'];
        state['storedLogin'] = {
            ok: true,
            source: read.source,
            hasRefreshToken: typeof read.login.refresh_token === 'string',
            hasClientId: typeof read.login.client_id === 'string',
            hasClientSecret: typeof read.login.client_secret === 'string',
            issuer: read.login.issuer_url ?? null,
            tenant: read.login.tenant_url ?? null,
            accessTokenExpiry: typeof exp === 'number' ? new Date(exp * 1000).toISOString() : null,
            accessTokenExpired: typeof exp === 'number' ? exp * 1000 < Date.now() : null,
        };
    }
    else {
        state['storedLogin'] = { ok: false, reason: read.reason };
    }
    return state;
}
//# sourceMappingURL=auth.js.map