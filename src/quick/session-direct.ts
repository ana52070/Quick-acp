/**
 * Session resolution that does NOT use the outpost.
 *
 * WHY
 * ---
 * The outpost was originally the only way to get a session, and it needs the
 * Electron main process (or a binary started with the right env). That means a
 * machine with no Quick install cannot use this bridge at all — which defeats
 * the point.
 *
 * Probing the stored login showed everything the gateway handshake needs is
 * already in the credential blob:
 *
 *   tenant_url  https://qbs-xxxx.dp.appintegrations.us-east-1.prod.plato.ai...
 *   issuer_url  https://identitycenter.amazonaws.com/ssoins-xxxx
 *   external_id / role / aws_account_id   (actor identity)
 *
 * and `ws_host` reported by the outpost is exactly `tenant_url` minus its
 * scheme. So: refresh the token ourselves (oidc.ts), strip the scheme off
 * tenant_url, and dial. No outpost, no instance token, no Electron.
 *
 * WHAT IS STILL UNKNOWN WITHOUT THE OUTPOST
 * -----------------------------------------
 * `actor_arn` comes back EMPTY from the outpost too on this deployment
 * (`"actor_arn": ""`), so it is not something we can lose. `outpost_device_id`
 * is replaced by the local device id from ~/.quickwork/device_id when present,
 * otherwise a stable random one.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readStoredLogin, type StoredLogin } from './credstore.js';
import { refreshIdToken } from './oidc.js';
import type { QuickSession } from './auth.js';
import { DEFAULT_WS_PATH, surfaceForPlatform } from './auth.js';

function quickworkHome(): string {
  return process.env.QUICK_ACP_QUICKWORK_HOME ?? join(homedir(), '.quickwork');
}

/** The device id the app generates once and reuses. */
function readDeviceId(): string {
  const p = join(quickworkHome(), 'device_id');
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * `ws_host` is the tenant URL without its scheme. Verified: the outpost reports
 * exactly this transformation for the same account.
 */
export function wsHostFromTenant(tenantUrl: string): string {
  return tenantUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export interface DirectSessionResult {
  ok: boolean;
  session?: QuickSession;
  /** Which step failed, when ok is false. */
  step?: 'credential' | 'refresh' | 'tenant';
  reason?: string;
}

/**
 * Build a session from the stored login alone.
 *
 * Returns a failure rather than throwing so the caller can fall back to the
 * outpost and report both reasons.
 *
 * SOURCE ORDER: our own `login.json` first, then the desktop app's keychain
 * entry. That order matters — a sign-in done through `login-cli.js` is by
 * definition the newest credential on the machine, while the app's entry can be
 * stale (and a stale-but-unexpired access token is the one thing the gateway
 * rejects with 401 while everything looks healthy).
 */
export async function sessionDirect(
  opts: { preferAccessToken?: boolean } = {},
): Promise<DirectSessionResult> {
  const bridge = await readBridgeLogin();
  if (bridge) {
    const r = await sessionFromLogin(bridge, opts);
    if (r.ok) return r;
    if (process.env.QUICK_ACP_DEBUG === '1') {
      console.error(`[session] bridge login failed (${r.step}): ${r.reason}`);
    }
  }

  const read = await readStoredLogin();
  if (!read.ok) {
    if (bridge) {
      return {
        ok: false,
        step: 'credential',
        reason: 'the quick-acp login file did not yield a session and there is no app login either',
      };
    }
    return { ok: false, step: 'credential', reason: read.reason };
  }
  return sessionFromLogin(read.login, opts);
}

/**
 * Login written by `login-cli.js` (`~/.quick-acp/login.json`).
 *
 * That file holds everything the OAuth flow produced EXCEPT the gateway host,
 * which the token response does not include. We therefore merge in `tenant_url`
 * from the app's profile when one exists, and otherwise expect the user to have
 * supplied it — a session cannot be dialled without it.
 */
async function readBridgeLogin(): Promise<StoredLogin | null> {
  const p = join(homedir(), '.quick-acp', 'login.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const tenantUrl = typeof j['tenant_url'] === 'string' ? j['tenant_url'] : '';
    if (!tenantUrl) return null;
    return {
      issuer_url: j['issuer_url'],
      tenant_url: tenantUrl,
      client_id: j['client_id'],
      client_secret: j['client_secret'],
      access_token: j['access_token'],
      access_token_expiry: j['expires_at'],
      refresh_token: j['refresh_token'],
      role: j['role'],
    } as StoredLogin;
  } catch {
    return null;
  }
}

/**
 * Exposed so the outpost path can reuse it once it has a login in hand.
 *
 * TOKEN SELECTION — the non-obvious part
 * --------------------------------------
 * The default is to REFRESH, even when the stored access token has not expired
 * yet. Reason: a locally-unexpired token is not proof of anything. During
 * development the keychain held an access token with 18 minutes left that the
 * gateway rejected with 401 on every attempt — the clock said fine, the server
 * said no. Refreshing costs one HTTP round trip and removes that whole class of
 * "everything looks healthy but nothing works".
 *
 * `preferAccessToken: true` exists for callers that must avoid the extra call
 * (offline diagnostics). It falls back to the cached token only if the refresh
 * itself fails.
 */
export async function sessionFromLogin(
  login: StoredLogin,
  opts: { preferAccessToken?: boolean } = {},
): Promise<DirectSessionResult> {
  const tenantUrl =
    typeof login.tenant_url === 'string' && login.tenant_url ? login.tenant_url : '';
  if (!tenantUrl) {
    return {
      ok: false,
      step: 'tenant',
      reason:
        'the stored login has no tenant_url, which is the gateway host. ' +
        'This deployment records it in profiles.json — check that file.',
    };
  }

  const accessToken = typeof login.access_token === 'string' ? login.access_token : '';
  const accessExpiry =
    typeof login.access_token_expiry === 'number' ? login.access_token_expiry : 0;
  const stillValid = Boolean(accessToken) && accessExpiry > Date.now() / 1000 + 60;

  let jwt = '';
  let expiresAt = accessExpiry;
  let source: QuickSession['source'] = 'credential';

  if (opts.preferAccessToken === true && stillValid) {
    // Explicitly asked to skip the refresh.
    jwt = accessToken;
  } else {
    const refreshed = await refreshIdToken(login);
    if (refreshed) {
      jwt = refreshed.accessToken;
      expiresAt = refreshed.expiresAt;
    } else if (stillValid) {
      // Refresh refused; the cached token may still be accepted.
      jwt = accessToken;
      source = 'cached';
    } else {
      return {
        ok: false,
        step: 'refresh',
        reason:
          'the stored refresh token was rejected by AWS and the cached access token has ' +
          'expired. Sign in again — either through the desktop app, or with ' +
          '`node dist/login-cli.js --start-url <portal URL>`.',
      };
    }
  }

  const deviceId = readDeviceId();

  return {
    ok: true,
    session: {
      jwt,
      wsHost: wsHostFromTenant(tenantUrl),
      wsPath: DEFAULT_WS_PATH,
      tenantUrl,
      surface: surfaceForPlatform(),
      outpostId: deviceId || randomUUID(),
      workingSessionId: randomUUID(),
      actorArn: '',
      provider: typeof login.role === 'string' ? login.role : '',
      source,
      expiresAt: expiresAt || Math.floor(Date.now() / 1000) + 3600,
    },
  };
}
