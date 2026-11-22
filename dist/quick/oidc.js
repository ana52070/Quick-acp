/**
 * OIDC token refresh against AWS IAM Identity Center.
 *
 * STATUS: WORKS. The first version of this file said it did not, and the two
 * reasons it failed are worth keeping written down because they are both easy
 * to repeat:
 *
 *   1. WRONG HOST
 *        https://oidc.<region>.amazonaws.com   -> 403 / 401 invalid_client
 *        https://oidc.<region>.api.aws         -> works
 *      The `.amazonaws.com` form is the old SSO OIDC host; the newer control
 *      plane lives on `.api.aws`. A 401 there looks like "wrong client" but is
 *      really "wrong host".
 *
 *   2. WRONG CREDENTIAL PLACEMENT
 *        client_id + client_secret in the FORM BODY  -> HTTP 400 "Invalid request"
 *        client_id:client_secret as BASIC AUTH       -> HTTP 200
 *      The refresh grant wants HTTP Basic. The authorization-code grant is the
 *      opposite (form fields — see login.ts). Getting these two backwards
 *      produces a 400 that says nothing useful.
 *
 * Verified live on 2026-11-21 against us-east-1: the stored refresh token was
 * exchanged for a fresh access token with HTTP 200.
 *
 * So this module is now the primary token source, and the outpost is needed
 * only for what the token cannot tell us: `ws_host`, `actor_arn`, `tenant_url`.
 */
export const OIDC_HOST = 'https://oidc.us-east-1.api.aws';
/**
 * Refresh the access token.
 *
 * Returns null (rather than throwing) when the credentials are unusable, so the
 * caller can fall back to the outpost without losing the reason — attach it to
 * the log via `QUICK_ACP_DEBUG=1`.
 */
export async function refreshIdToken(login) {
    const refreshToken = login.refresh_token;
    const clientId = login.client_id;
    const clientSecret = login.client_secret;
    if (!refreshToken || !clientId || !clientSecret)
        return null;
    for (const host of candidateHosts(login)) {
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        let resp;
        try {
            resp = await fetch(`${host}/token`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    authorization: `Basic ${basic}`,
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                }).toString(),
                signal: AbortSignal.timeout(30_000),
            });
        }
        catch {
            continue;
        }
        const text = await resp.text();
        if (resp.status !== 200) {
            if (process.env.QUICK_ACP_DEBUG === '1') {
                console.error(`[oidc] ${host} -> HTTP ${resp.status}: ${text.slice(0, 200)}`);
            }
            continue;
        }
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            continue;
        }
        const accessToken = body.access_token ?? body.id_token ?? '';
        if (!accessToken)
            continue;
        return {
            idToken: accessToken,
            accessToken,
            refreshToken: body.refresh_token ?? null,
            expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
        };
    }
    return null;
}
/**
 * Hosts to try, in order.
 *
 * `.api.aws` first because that is the confirmed-working one. The legacy
 * `.amazonaws.com` form is kept as a fallback in case AWS moves back or a
 * non-us-east-1 deployment behaves differently.
 */
function candidateHosts(login) {
    const hosts = [OIDC_HOST];
    const region = regionFromIssuer(login.issuer_url);
    if (region && region !== 'us-east-1') {
        hosts.push(`https://oidc.${region}.api.aws`);
    }
    if (region) {
        hosts.push(`https://oidc.${region}.amazonaws.com`);
    }
    return [...new Set(hosts)];
}
function regionFromIssuer(issuerUrl) {
    if (typeof issuerUrl !== 'string')
        return null;
    const m = issuerUrl.match(/\.([a-z]{2}-[a-z]+-\d)\./);
    return m?.[1] ?? 'us-east-1';
}
// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------
/**
 * Decode a JWT payload without verifying it.
 *
 * Verification is pointless here: the token is used immediately as an opaque
 * bearer, and the server is the only party that can judge it. We only read
 * `exp` to refresh ahead of time and `sub`/`email` for diagnostics.
 *
 * Note: the AWS tokens this app receives are NOT three-part JWTs — they look
 * like `aoaAAAA...:MGUCMQ...`, a proprietary envelope. So this returns null for
 * them rather than pretending to parse.
 */
export function decodeJwtClaims(token) {
    const parts = token.split('.');
    if (parts.length !== 3)
        return null;
    try {
        const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
        const v = JSON.parse(payload);
        return v && typeof v === 'object' ? v : null;
    }
    catch {
        return null;
    }
}
/**
 * Expiry (seconds since epoch) of a token, or 0 when unknown.
 *
 * Falls back to "one hour from now" for the opaque AWS envelope, because that
 * is what `expires_in` reports and it keeps the refresh timer sane.
 */
export function jwtExpiry(token) {
    const claims = decodeJwtClaims(token);
    const exp = claims?.['exp'];
    if (typeof exp === 'number')
        return exp;
    return Math.floor(Date.now() / 1000) + 3600;
}
//# sourceMappingURL=oidc.js.map