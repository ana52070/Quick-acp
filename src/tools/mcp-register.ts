/**
 * Register this bridge's MCP server into Quick's local outpost.
 *
 * Reconstructed endpoints (renderer `Qc()` in startup-*.js):
 *   GET  {outpost}/local/mcp/list
 *   POST {outpost}/local/mcp/add      -> { success, server: { id } }
 *   POST {outpost}/local/mcp/toggle   -> { success }
 *   POST {outpost}/local/mcp/remove   -> { success }
 *   POST {outpost}/local/mcp/reload   -> { success }
 *   GET  {outpost}/local/mcp/known-sources
 *
 * `/local/*` routes need the instance token as a Bearer, exactly like the
 * sncs-session route. `add` does NOT enable the server; a separate `toggle`
 * does, which the app performs in the same submit flow — so we do too, and we
 * report which half failed if it does.
 */

import { outpostPort } from '../quick/auth.js';

export interface RegistrationResult {
  ok: boolean;
  serverId?: string;
  enabled?: boolean;
  error?: string;
  /** Which step failed, when ok is false. */
  step?: 'list' | 'add' | 'toggle' | 'remove';
}

interface OutpostEnvelope {
  success?: boolean;
  error?: string;
  server?: { id?: string };
  servers?: unknown[];
}

function token(): string {
  const t = process.env.QUICK_ACP_INSTANCE_TOKEN;
  if (!t) {
    throw new Error(
      'QUICK_ACP_INSTANCE_TOKEN is required: /local/* routes need it as a Bearer token',
    );
  }
  return t;
}

function base(): string {
  return `http://127.0.0.1:${outpostPort()}`;
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 45_000,
): Promise<OutpostEnvelope> {
  const resp = await fetch(`${base()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token()}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  if (!text) return { success: resp.ok };
  try {
    return JSON.parse(text) as OutpostEnvelope;
  } catch {
    return { success: false, error: `non-JSON reply (HTTP ${resp.status}): ${text.slice(0, 200)}` };
  }
}

export async function listMcpServers(): Promise<unknown[]> {
  const r = await call('GET', '/local/mcp/list');
  return Array.isArray(r.servers) ? r.servers : [];
}

export interface RegisterOptions {
  /** Display name in Quick's MCP list. */
  name: string;
  /** Absolute path to the MCP server entry script. */
  scriptPath: string;
  /** Node binary to spawn it with. */
  nodePath?: string;
  /** Env vars passed to the spawned server. */
  env?: Record<string, string>;
  /** Workspace root the tools are confined to. */
  workspaceRoot: string;
  allowShell: boolean;
  /** Replace an existing registration with the same name. */
  replace?: boolean;
}

/**
 * Build the `/local/mcp/add` body.
 *
 * Field requirements, established by probing the live outpost (each error below
 * is a real reply, not a guess):
 *
 *   {}                                    -> "Missing required fields (id, name)"
 *   -envVars/-headers                     -> "Missing required fields (id, name)"   (id/name still needed)
 *   {id,name}                             -> "Missing command for stdio transport"
 *   {id,name,command,args}                -> success
 *   {..., envVars: []} or headers: []     -> "Invalid header or environment value"
 *
 * So: `id` is REQUIRED (the app's form derives it from the name), and an EMPTY
 * envVars/headers array is invalid — the keys must be OMITTED when unused.
 * Sending `[]` is the trap: it looks harmless and fails.
 */
export function buildRegisterPayload(opts: {
  name: string;
  scriptPath: string;
  nodePath?: string;
  workspaceRoot: string;
  allowShell: boolean;
  env?: Record<string, string>;
  /** Defaults to the name, slugified. The outpost requires it. */
  id?: string;
}): Record<string, unknown> {
  const id = opts.id ?? slugify(opts.name);

  // Only include envVars when there is at least one real entry: an empty array
  // is rejected outright.
  const envEntries = Object.entries({
    QUICK_ACP_WORKSPACE: opts.workspaceRoot,
    QUICK_ACP_ALLOW_SHELL: opts.allowShell ? '1' : '0',
    ...(opts.env ?? {}),
  }).map(([key, value]) => ({ key, value }));

  return {
    id,
    name: opts.name,
    description: 'quick-acp local tool bridge (shell + file tools)',
    command: opts.nodePath ?? process.execPath,
    args: [opts.scriptPath],
    // stdio form: url is an empty string, not omitted.
    url: '',
    startupTimeout: 30,
    ...(envEntries.length > 0 ? { envVars: envEntries } : {}),
    // headers is omitted entirely: `[]` is rejected, and stdio needs none.
    hostOnOutpost: false,
  };
}

/** The outpost's id must be a simple token; the app slugifies the name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'quick-acp-tools';
}

/**
 * Register (and enable) the MCP server.
 *
 * Idempotent: if a server with the same name already exists and `replace` is
 * set, it is removed first, because `add` on a duplicate name is refused.
 */
/**
 * Register the MCP server.
 *
 * IDEMPOTENCE — the part that matters for usability
 * -------------------------------------------------
 * The user has to enable the server once, by hand, in Quick's UI (see the
 * attestation note at the bottom of this file). That click must survive a
 * restart: if every launch removed and re-added the server, the fresh record
 * would come back `enabled: false` and the user would have to click again
 * forever. So when a server with this name already exists we REUSE it and never
 * remove it during normal startup.
 *
 * `replace: true` is therefore only for an explicit "re-register" action (a
 * changed command line), never the automatic path.
 */
export async function registerMcpServer(opts: RegisterOptions): Promise<RegistrationResult> {
  let existing: Array<{ id?: string; name?: string; enabled?: boolean }> = [];
  try {
    existing = (await listMcpServers()) as typeof existing;
  } catch (e) {
    return {
      ok: false,
      step: 'list',
      error: `could not reach the outpost at ${base()}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const clash = existing.find((s) => s?.name === opts.name);

  // Already registered: report its state instead of recreating it. Recreating
  // would silently discard the user's one-time enable.
  if (clash?.id && !opts.replace) {
    if (clash.enabled === true) {
      return { ok: true, serverId: clash.id, enabled: true };
    }
    return {
      ok: false,
      step: 'toggle',
      serverId: clash.id,
      enabled: false,
      error:
        `MCP server "${opts.name}" is already registered (id ${clash.id}) but is not enabled. ` +
        'Enable it once in Quick -> Settings -> MCP servers; the setting persists across ' +
        'restarts, so this is a one-time step.',
    };
  }

  if (clash?.id) {
    const removed = await call('POST', '/local/mcp/remove', { id: clash.id });
    if (!removed.success) {
      return {
        ok: false,
        step: 'remove',
        error: removed.error ?? 'the outpost refused to remove the existing server',
      };
    }
  }

  // Payload shape mirrors the app's AddIntegrationModal (Tra in startup-*.js):
  // stdio form keeps url as an empty string rather than omitting it.
  const payload = buildRegisterPayload({
    name: opts.name,
    scriptPath: opts.scriptPath,
    nodePath: opts.nodePath,
    workspaceRoot: opts.workspaceRoot,
    allowShell: opts.allowShell,
    env: opts.env,
  });

  const added = await call('POST', '/local/mcp/add', payload);
  if (!added.success || !added.server?.id) {
    return {
      ok: false,
      step: 'add',
      error: added.error ?? 'the outpost accepted the request but returned no server id',
    };
  }

  const serverId = added.server.id;

  // ---------------------------------------------------------------------
  // Enable step — requires an Ed25519 attestation we cannot mint.
  //
  // The outpost refuses `toggle` with "Invalid or missing confirmation nonce"
  // unless the request carries {nonce, signature, timestamp, jti, hashVersion,
  // outpostId} produced by the Electron MAIN process, which holds an ephemeral
  // per-boot Ed25519 keypair in memory (see dist/main/mcpAttestation.js) and
  // never exposes the private half.
  //
  // That is a deliberate anti-tamper control: a tool server that can enable
  // itself is a privilege-escalation path. We do NOT try to fake it. Instead:
  //   - the server is registered, so it appears in Quick's MCP list;
  //   - we report exactly what the user must click, once.
  // ---------------------------------------------------------------------
  const toggled = await call('POST', '/local/mcp/toggle', { id: serverId, enabled: true });
  if (toggled.success) {
    return { ok: true, serverId, enabled: true };
  }

  return {
    ok: false,
    step: 'toggle',
    serverId,
    enabled: false,
    error:
      `registered as "${opts.name}" (id ${serverId}) but it is NOT enabled yet. ` +
      'Quick requires a signed confirmation from its own main process to toggle a ' +
      'server on, which only the desktop app can produce. ' +
      'Open Quick -> Settings -> MCP servers and switch "' +
      opts.name +
      '" on (one click, one time). ' +
      `Outpost said: ${toggled.error ?? 'unknown'}`,
  };
}

export async function removeMcpServer(serverId: string): Promise<RegistrationResult> {
  const r = await call('POST', '/local/mcp/remove', { id: serverId });
  return r.success
    ? { ok: true, serverId }
    : { ok: false, step: 'remove', error: r.error ?? 'remove refused' };
}
