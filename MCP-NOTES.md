# mcp-native branch

This branch keeps the **native MCP tool path** intact so the research is not
lost. `main` does not carry it, because enabling a local MCP server requires the
Quick desktop app and that contradicts the project's main goal (work on a clean
machine with a browser sign-in and nothing else).

## What is here that `main` does not have

| File | Purpose |
|---|---|
| `src/tools/mcp-server.ts` | stdio MCP server (initialize / tools/list / tools/call / ping) |
| `src/tools/mcp-register.ts` | registers it into the outpost via `/local/mcp/*` |
| `src/mcp-main.ts` | the actual spawnable entry point |
| `src/mcp-smoke.ts` | 7 wire-level checks against that server |
| `src/tools/strategies.ts` | `mcp` branch of the strategy switch |
| `src/acp/agent.ts` | `ensureMcpRegistered()` and the mcp-vs-inject decision |

## Why it is not the default

Enabling a local MCP server is gated twice, and both gates belong to the
desktop app:

### Gate 1 — org permission (`permissions_pending`)

Every mutating call (`add`, `toggle`, `remove`, `reload`) answers:

```json
HTTP 503
{"success": false,
 "error": "Local MCP creation and modification is temporarily unavailable while your organization's permissions are loading. Try again shortly.",
 "errorCode": "permissions_pending",
 "retryable": true}
```

Characterised by probing the live outpost:

- It is a **global write gate**: a brand-new, non-existent server id gets the
  same answer. It is not about the record.
- It does **not** clear on retry (8 attempts over 64 s, unchanged).
- Reads are not gated: `GET /local/mcp/list` → 200, `known-sources` → 200.

It is a real transient state, not a permanent refusal. The desktop app's own log
shows it resolving:

```
18:37:29 [OutpostServer] admin controls unresolved after 30.0s; MCP mutations remain pending
18:37:47 [OutpostBoot]   local_mcp_connect gate=resolved gate_wait_ms=0
```

So the permission is pulled by a signed-in desktop app. The renderer models this
explicitly:

```js
// loading  (custom perms not enabled yet, OR rollout unresolved)
if (i && !l) return "Local MCP permissions are loading. Try again shortly.";
// denied   (policies resolved and they say no)
if (d === "modify" && (s || i && a))
  return "Your administrator has disabled creating and modifying local MCP servers.";
```

with `i = localMcpCustomPermissionsEnabled || !localMcpRolloutResolved` and
`l = deniesResolved`.

### Gate 2 — command confirmation nonce

`toggle` additionally wants `{nonce, signature, timestamp, jti, hashVersion,
outpostId}`. The renderer builds these with:

```js
function v9(e, t) {
  return { nonce: e.nonce, signature: e.signature, timestamp: e.timestamp,
           jti: e.jti, hashVersion: e.hashVersion, outpostId: t };
}
```

All six come from the main process's `confirm-mcp-server` IPC handler, which
shows a native OS dialog and then signs an Ed25519 attestation with a keypair
generated per boot, held only in main-process memory.

**Important nuance** — the main process separates the two hashes:

```js
// commandHash (v1) → nonce file for the outpost;
// attestHash (v2) → signed for the cell.
```

So the v1 hash is verified locally against `~/.quickwork/.mcp_confirm_nonces.json`
and the v2 signature goes to the remote cell. The renderer sends all fields
together, which does **not** prove the local HTTP route validates the signature.
`mcpAttestationGuard.js` proves only that the renderer may not relay the
attestation upload — an anti-XSS boundary.

**Accurate conclusion:** this bridge does not implement its own permission
initialisation and confirmation chain. That is different from "technically
impossible".

## What a complete solution would need

1. Trigger org policy resolution ourselves so `permissions_pending` clears.
2. Implement the command-confirmation prompt (replacing the Electron dialog) —
   the user must see exactly what will run.
3. Publish the tool schema to the cloud.

Steps 1–2 are engineering. Step 3 has no discovered interface yet.

## Relevant lead: device-tool relay

The gateway does have a client-side execution channel — the renderer handles:

```js
if (r.type === `tool_call`) { Yx(w, r.payload, r.thread_id, RZe); return; }
```

`Yx()` takes `tool_name` / `arguments` / `tool_call_id`, runs it locally, and
replies with `{type:"tool_result", payload:{tool_call_id, result, error}}`.
`outpostToolInvoke.js` describes the renderer as the courier for
cloud → device tool calls, executed via `/local/invoke_tool`.

So executing a tool *from* the gateway is possible. What is still missing is how
a caller publishes its own tool schema so the model knows `shell_run` exists.
`pre_approved_tools` is a list of names, not definitions. That is the open
question, and the most promising direction for making MCP-free native tools work.

## Fixes that live on this branch (they matter if it is ever revived)

These were found by review and are committed here:

- **Entry point**: must be `dist/mcp-main.js`. `dist/tools/mcp-server.js` only
  exports functions and has no `main()`, so spawning it prints nothing and exits
  0 — a server that "starts fine" and answers nothing.
- **No remove+add on startup**: the user enables the server once; recreating the
  record would reset it to `enabled: false` and force another click forever.
- **Fallback to inject**: if registration fails, the turn now runs the injected
  tool contract instead of silently running with no tools at all.
