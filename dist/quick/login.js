/**
 * Real login: obtain a Quick session on a machine that has never run the
 * official client.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything else in this bridge assumes a stored login: read the credential
 * from Windows Credential Manager, hand the refresh token to the outpost, done.
 * That works only after the user installed and signed into the desktop app.
 *
 * The app's own client is a standard OAuth PKCE public client — the evidence is
 * in its own stored `client_secret`, which is a plain JWT whose payload says:
 *
 *   {"clientType":"PUBLIC",
 *    "enabledGrants":{"AUTH_CODE":{"redirectUris":["http://127.0.0.1:18080"]},
 *                     "REFRESH_TOKEN":{...}}}
 *
 * So the login can be reproduced without the Electron shell:
 *
 *   1. POST /client/register          -> clientId + clientSecret (dynamic reg)
 *   2. GET  /authorize (PKCE + S256)  -> 302 to the AWS sign-in page
 *   3. user signs in; AWS redirects to http://127.0.0.1:18080?code=...
 *   4. POST /token (auth code)        -> access_token + refresh_token
 *
 * VERIFIED END TO END on 2026-11-21 against us-east-1: every step returned 200
 * and produced a usable token. See LOGIN-NOTES.md for the raw transcripts.
 *
 * WHAT THE CALLER GETS
 * --------------------
 * Exactly the fields `profiles.json` records, so the outpost can be pointed at
 * a home directory containing it — no Quick install, no credential-manager
 * entry, no 200 MB Electron shell.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** The OIDC control plane. NOT `oidc.<region>.amazonaws.com` — that host 403s. */
const OIDC_HOST = 'https://oidc.us-east-1.api.aws';
/**
 * Redirect URI must match the one Quick's own client registered, because the
 * authorize request is checked against the client's registered grants.
 */
const REDIRECT_PORT = 18080;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}`;
const SCOPE = 'quicksight:read_write';
/**
 * Derive the issuer from any of the forms a user might paste:
 *
 *   https://ssoins-xxxx.awsapps.com/start          (the access-portal URL)
 *   ssoins-xxxx.awsapps.com/start
 *   https://ssoins-xxxx.awsapps.com
 *   ssoins-xxxx                                    (bare instance id)
 *   https://identitycenter.amazonaws.com/ssoins-xxxx  (the issuer itself)
 *
 * All of them collapse to https://identitycenter.amazonaws.com/<instance>.
 */
export function issuerFromStartUrl(input) {
    const raw = input.trim();
    if (!raw)
        return null;
    const idc = raw.match(/identitycenter\.amazonaws\.com\/(ssoins-[a-z0-9]+)/i);
    if (idc?.[1])
        return `https://identitycenter.amazonaws.com/${idc[1]}`;
    const portal = raw.match(/(ssoins-[a-z0-9]+)\.awsapps\.com/i);
    if (portal?.[1])
        return `https://identitycenter.amazonaws.com/${portal[1]}`;
    const bare = raw.match(/^(ssoins-[a-z0-9]+)$/i);
    if (bare?.[1])
        return `https://identitycenter.amazonaws.com/${bare[1]}`;
    return null;
}
/** Pull the instance id back out of an issuer URL, for building portal links. */
export function instanceIdFromIssuer(issuerUrl) {
    const m = issuerUrl.match(/identitycenter\.amazonaws\.com\/(ssoins-[a-z0-9]+)/i);
    return m?.[1] ?? null;
}
async function postJson(path, body) {
    const resp = await fetch(OIDC_HOST + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    let parsed = {};
    try {
        parsed = JSON.parse(text);
    }
    catch {
        parsed = { raw: text };
    }
    return { status: resp.status, body: parsed };
}
/**
 * Register a throwaway public client for this sign-in.
 *
 * Field names matter and were established by probing (each wrong one returns a
 * different validation error, which is how they were found):
 *
 *   startUrl     -> "Start URL is required" (ignored; the API does not want it)
 *   issuerUrl    -> accepted, returns clientId + clientSecret
 *   scopes as [] -> "Scopes are required for this grant"
 *   scopes:[str] -> accepted
 */
export async function registerClient(issuerUrl) {
    const r = await postJson('/client/register', {
        clientName: 'quick-acp',
        clientType: 'PUBLIC',
        grantTypes: ['authorization_code', 'refresh_token'],
        redirectUris: [REDIRECT_URI],
        scopes: [SCOPE],
        issuerUrl,
    });
    const clientId = typeof r.body['clientId'] === 'string' ? r.body['clientId'] : '';
    const clientSecret = typeof r.body['clientSecret'] === 'string' ? r.body['clientSecret'] : '';
    if (r.status !== 200 || !clientId || !clientSecret) {
        throw new Error(`client registration failed (HTTP ${r.status}): ${JSON.stringify(r.body).slice(0, 300)}. ` +
            'Check that the issuer/start URL belongs to an IAM Identity Center instance.');
    }
    return { clientId, clientSecret };
}
/** Build the authorize URL and its PKCE verifier. */
export function buildAuthorizeUrl(opts) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('hex');
    const url = new URL(OIDC_HOST + '/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', opts.clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), verifier, state };
}
/**
 * Start the loopback listener and wait for the browser callback.
 *
 * Resolves with the authorization code. Rejects on an error callback, a state
 * mismatch (CSRF), or the timeout.
 */
export function waitForCallback(opts) {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const u = new URL(req.url ?? '/', REDIRECT_URI);
            const code = u.searchParams.get('code');
            const error = u.searchParams.get('error');
            const state = u.searchParams.get('state');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            if (error) {
                res.end(`<h2>quick-acp: sign-in failed</h2><pre>${error}</pre>`);
            }
            else if (code && state !== opts.expectedState) {
                res.end('<h2>quick-acp: state mismatch — sign-in rejected</h2>');
            }
            else if (code) {
                res.end('<h2>quick-acp: signed in</h2><p>You can close this tab.</p>');
            }
            else {
                res.end('<h2>quick-acp: no code in callback</h2>');
            }
            server.close();
            if (error)
                reject(new Error(`the sign-in page returned "${error}"`));
            else if (!code)
                reject(new Error('the callback carried no authorization code'));
            else if (state !== opts.expectedState)
                reject(new Error('state mismatch (possible CSRF)'));
            else
                resolve({ code, close: () => server.close() });
        });
        server.on('error', (e) => {
            reject(new Error(`cannot listen on ${REDIRECT_URI}: ${e.message}. The port is fixed by the ` +
                "app's registered redirect URI, so another program using 18080 will block sign-in."));
        });
        server.listen(REDIRECT_PORT, '127.0.0.1');
        setTimeout(() => {
            server.close();
            reject(new Error(`no browser callback within ${Math.round(opts.timeoutMs / 1000)}s`));
        }, opts.timeoutMs);
    });
}
/**
 * Exchange the code for tokens.
 *
 * The body shape is the whole point, and the endpoint is picky in a way that is
 * not documented anywhere:
 *
 *   client_id/client_secret as FORM FIELDS  -> 200   (what works)
 *   client_id/client_secret as Basic auth   -> 400 "Invalid request"
 *   both places                             -> 400 "should not be provided in both"
 *
 * Verified live against us-east-1. Because a 400 here reports nothing useful
 * ("Invalid request"), the shapes are tried in order and the first 200 wins;
 * the failure of every shape is then reported with each status, so the next
 * person sees what was attempted rather than a bare 400.
 */
export async function exchangeCode(opts) {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    const base = {
        grant_type: 'authorization_code',
        code: opts.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: opts.verifier,
    };
    const shapes = [
        {
            // The confirmed-good shape: everything as form fields, no Basic auth.
            label: 'form+client-fields',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                ...base,
                client_id: opts.clientId,
                client_secret: opts.clientSecret,
            }).toString(),
        },
        {
            label: 'form+basic',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                authorization: `Basic ${basic}`,
            },
            body: new URLSearchParams(base).toString(),
        },
        {
            label: 'json+client-fields',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                ...base,
                clientId: opts.clientId,
                clientSecret: opts.clientSecret,
            }),
        },
    ];
    const attempts = [];
    for (const shape of shapes) {
        const resp = await fetch(OIDC_HOST + '/token', {
            method: 'POST',
            headers: shape.headers,
            body: shape.body,
            signal: AbortSignal.timeout(30_000),
        });
        const text = await resp.text();
        if (resp.status === 200) {
            const parsed = JSON.parse(text);
            if (process.env.QUICK_ACP_DEBUG === '1') {
                console.error(`[login] token exchange succeeded with shape "${shape.label}"`);
            }
            return parsed;
        }
        attempts.push(`${shape.label} -> HTTP ${resp.status} ${text.slice(0, 120)}`);
    }
    throw new Error(`token exchange failed:\n  ${attempts.join('\n  ')}`);
}
/**
 * Refresh an access token.
 *
 * Refresh DOES work directly — the earlier note in this project claiming
 * otherwise was wrong. The two mistakes were the host and the credential
 * placement:
 *   host  : oidc.<region>.amazonaws.com  -> 403 / invalid_client
 *           oidc.<region>.api.aws        -> works
 *   secret: in the body                  -> "Invalid request"
 *           via Basic auth               -> works
 */
export async function refreshAccessToken(opts) {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    const resp = await fetch(OIDC_HOST + '/token', {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: opts.refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    if (resp.status !== 200) {
        throw new Error(`token refresh failed (HTTP ${resp.status}): ${text.slice(0, 300)}`);
    }
    const body = JSON.parse(text);
    return {
        accessToken: String(body['access_token'] ?? ''),
        refreshToken: String(body['refresh_token'] ?? opts.refreshToken),
        expiresIn: Number(body['expires_in'] ?? 3600),
    };
}
/** Where profiles live. Mirrors what the desktop app uses. */
export function quickworkHome() {
    return process.env.QUICK_ACP_QUICKWORK_HOME ?? join(homedir(), '.quickwork');
}
/** Profile id shape the app uses: "<provider>-<12 hex>". */
function newProfileId() {
    return `social-${randomBytes(6).toString('hex')}`;
}
/**
 * Write a `profiles.json` the outpost will accept.
 *
 * The outpost reads the issuer/tenant/client hints from here and obtains the
 * actual tokens from the OS keychain — which we populate separately. Writing
 * this file is what makes a machine with no Quick install look "signed in" to
 * the outpost.
 */
export async function persistProfile(opts) {
    const home = opts.home ?? quickworkHome();
    const profileId = opts.login.profileId ?? newProfileId();
    const dir = join(home, 'profiles', profileId);
    await mkdir(dir, { recursive: true });
    const path = join(home, 'profiles.json');
    let existing = {
        version: 1,
        entries: [],
    };
    if (existsSync(path)) {
        try {
            existing = JSON.parse(await readFile(path, 'utf8'));
        }
        catch {
            /* start fresh rather than refuse to write */
        }
    }
    const entry = {
        id: profileId,
        provider: 'social',
        display_name: opts.displayName ?? 'quick-acp',
        data_path: `profiles/${profileId}`,
        login_metadata: {
            issuer_url: opts.login.issuerUrl,
            tenant_url: opts.login.tenantUrl,
            client_id: opts.login.clientId,
        },
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
        refresh_failing_since: null,
    };
    const entries = Array.isArray(existing.entries) ? existing.entries : [];
    const without = entries.filter((e) => e?.id !== profileId);
    await writeFile(path, JSON.stringify({ version: 1, entries: [...without, entry], last_active: profileId }, null, 2) + '\n', 'utf8');
    return path;
}
/**
 * Write the bridge's own login file.
 *
 * Separate from `profiles.json` on purpose: this is OUR artifact, holding the
 * tokens and client credentials the OAuth flow produced. `profiles.json` is the
 * desktop app's file and only carries hints — writing secrets into a file the
 * app owns would be rude and confusing.
 *
 * `tenant_url` is the gateway host. The token response does not include it, so
 * the caller must supply it (see discoverTenantUrl) or the session cannot dial.
 */
export async function persistBridgeLogin(opts) {
    const dir = join(homedir(), '.quick-acp');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'login.json');
    await writeFile(path, JSON.stringify({
        issuer_url: opts.login.issuerUrl,
        tenant_url: opts.tenantUrl ?? null,
        client_id: opts.login.clientId,
        client_secret: opts.login.clientSecret,
        access_token: opts.login.accessToken,
        refresh_token: opts.login.refreshToken,
        expires_at: opts.login.expiresAt,
        role: opts.role ?? null,
        signed_in_at: new Date().toISOString(),
    }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    return path;
}
/**
 * Find the gateway host for an account.
 *
 * The tenant URL is not part of the OAuth response and there is no public
 * discovery endpoint for it. Three sources, best first:
 *
 *   1. an existing Quick profile (the desktop app records it in profiles.json)
 *   2. QUICK_ACP_TENANT_URL, for a user who was told theirs
 *   3. a running outpost's /auth/status, when the app happens to be open
 *
 * Returns '' when none is available — calling code must treat that as "ask the
 * user" rather than inventing a host.
 */
export async function discoverTenantUrl() {
    const env = process.env.QUICK_ACP_TENANT_URL;
    if (env)
        return env;
    // 1. profiles.json
    try {
        const path = join(quickworkHome(), 'profiles.json');
        if (existsSync(path)) {
            const j = JSON.parse(await readFile(path, 'utf8'));
            const entries = j.entries ?? [];
            const active = entries.find((e) => e.login_metadata?.tenant_url);
            const t = active?.login_metadata?.tenant_url;
            if (typeof t === 'string' && t)
                return t;
        }
    }
    catch {
        /* fall through */
    }
    // 2. the desktop app's outpost, if it is running
    try {
        const port = process.env.QUICKWORK_OUTPOST_PORT ?? '8780';
        const r = await fetch(`http://127.0.0.1:${port}/auth/status`, {
            signal: AbortSignal.timeout(2_000),
        });
        if (r.ok) {
            const j = (await r.json());
            const t = j['tenant_url'];
            if (typeof t === 'string' && t)
                return t;
        }
    }
    catch {
        /* outpost not running */
    }
    return '';
}
/** Where bridge logins live. */
export function bridgeLoginPath() {
    return join(homedir(), '.quick-acp', 'login.json');
}
/**
 * Full interactive sign-in.
 *
 * `onUrl` is called with the sign-in URL so a CLI can print it and an ACP client
 * can surface it; the flow then blocks until the browser comes back.
 */
export async function login(opts) {
    const issuerUrl = issuerFromStartUrl(opts.startUrl);
    if (!issuerUrl) {
        return {
            ok: false,
            error: `could not read an IAM Identity Center instance from "${opts.startUrl}". ` +
                'Expected something like https://ssoins-xxxxx.awsapps.com/start — the address ' +
                'of your AWS access portal. Copy it from the browser after signing in there.',
        };
    }
    const instanceId = instanceIdFromIssuer(issuerUrl);
    let clientId;
    let clientSecret;
    try {
        ({ clientId, clientSecret } = await registerClient(issuerUrl));
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const { url, verifier, state } = buildAuthorizeUrl({ clientId, issuerUrl });
    // The authorize endpoint redirects to the sign-in host. Follow one hop so the
    // URL we hand out is the one the user actually needs to open.
    let signInUrl = url;
    try {
        const resp = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        const loc = resp.headers.get('location');
        if (loc)
            signInUrl = loc;
    }
    catch {
        /* keep the original URL; the browser will follow the same redirect */
    }
    const waiter = waitForCallback({ expectedState: state, timeoutMs: opts.timeoutMs ?? 600_000 });
    opts.onUrl?.(signInUrl);
    let code;
    try {
        ({ code } = await waiter);
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), issuerUrl, clientId };
    }
    let tokens;
    try {
        tokens = await exchangeCode({ clientId, clientSecret, code, verifier });
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), issuerUrl, clientId };
    }
    const result = {
        ok: true,
        issuerUrl,
        clientId,
        clientSecret,
        accessToken: String(tokens['access_token'] ?? ''),
        refreshToken: String(tokens['refresh_token'] ?? ''),
        expiresAt: Math.floor(Date.now() / 1000) + Number(tokens['expires_in'] ?? 3600),
        profileId: newProfileId(),
    };
    // The gateway host is not in the token response and there is no public
    // discovery endpoint for it, so it is looked up separately. Failing to find
    // it is not a sign-in failure — the tokens are still good — but the caller
    // must know the session cannot be dialled yet.
    const tenantUrl = await discoverTenantUrl();
    if (tenantUrl)
        result.tenantUrl = tenantUrl;
    if (opts.persist) {
        try {
            // Our own artifact: tokens + client credentials, mode 0600.
            await persistBridgeLogin({ login: result, tenantUrl: tenantUrl || undefined });
            // And the profile the outpost reads, in case the user wants that path.
            // Only written when we know the tenant, because a profile without it is
            // useless to the outpost.
            if (tenantUrl) {
                result.profilePath = await persistProfile({
                    login: result,
                    displayName: opts.displayName ?? (instanceId ? `quick-acp (${instanceId})` : undefined),
                });
            }
        }
        catch (e) {
            result.ok = false;
            result.error = `signed in, but could not write the login file: ${e instanceof Error ? e.message : String(e)}`;
        }
    }
    return result;
}
//# sourceMappingURL=login.js.map