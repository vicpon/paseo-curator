# Curator routing: controls and verification

## Current contract

PR7 discovers the authenticated host SDK catalog (`entries`, `provider`, `enabled`,
`status: "ready"`). Discovery returns only enabled entries. Settings offer only usable
providers and None; there is no provider availability/safety list or collapsed diagnostic view.
Blocked names, models and reasons are absent from normal settings. Fixed technical reasons
are logged in the app runtime console without host labels, models or raw errors.
A failed refresh clears stale provider choices.

Source reviews retain the exact provider/model, including nested model IDs. Fallback is only
the explicitly saved provider/model; **None is the default**. No provider preference order is
used. A selected provider disabled or removed at the host disappears from the list and menu;
the saved consent stays unchanged and the UI shows a generic inactive selection. It never
silently saves None or another provider. None remains usable while discovery is pending.

The adapter resolves native options with `providers.listControls` for the selected route and
cwd, then checks enabled/ready status and explicit fallback consent again before create.
Missing, stripped or erroring controls fail closed. A provider disabled during resolution
cannot trigger a create-failure fallback to another provider. These checks cannot be atomic
with the host's subsequent create; already submitted prompts cannot be recalled.

Reviewer identity includes route, native policy, source turn and queue attempt. IDs are
registered before asynchronous creation. The permission guard denies approval-gated requests
for those IDs; it is defense in depth, not proof that native tools are confined.
Plugin-owned pre-review versions and apply-time claim fencing remain authoritative. Model
`readSet` is advisory; plugin code applies and audits validated proposals.

## Supported family matrix

Observed host: desktop-managed Paseo **0.17.0-beta.1**, Linux, 2026-11-20. Pinned plugin/client
SDK: 0.16.0-beta.2. Availability alone does not prove authentication or a successful request.

| Family | Host | Curator native policy | Actual live result |
|---|---|---|---|
| Codex | Enabled / ready | `sandbox_mode: "read-only"`, `approval_policy: "never"` | `codex/gpt-6.2-sol`: real source and review completed; disposable SQLite queue/audit `nothing_to_save`, one attempt, zero operations. Canary unchanged. Model reported edit and shell sandbox denials, but the host returned projected history without those tool events; do not treat that report alone as independent execution-denial proof. |
| Claude | Enabled / ready | `extraArgs.tools: "Read,Glob,Grep"`, matching `allowedTools`, `disallowedTools: ["mcp__*"]` | `claude/claude-haiku-4-5`: real source/review completed; SQLite `nothing_to_save`, one attempt, zero operations. Native Write call failed with “No such tool available: Write”; canary unchanged. Model reported no shell tool. |
| OpenCode | Enabled / ready | `permission: "deny"`, `auto_accept: false`, empty MCP preapprovals | `opencode/openai/gpt-6.2-sol`: real source/review completed; SQLite `nothing_to_save`, one attempt, zero operations. Canary unchanged; reviewer reported no file-write/shell tools and made no overwrite attempt. This is not a forced extension-tool execution test. |
| OMP | Enabled / ready | Review blocked | Current host cannot pass native tool filtering or a sandbox through its strict per-session options. `ask` alone is unsafe: installed native policy resolution honors explicit tool/user allows before its mode default. No unsafe inference was launched. |
| Hermes | Enabled / ready, custom ACP | Review blocked | ACP launcher does not expose per-session native toolset filtering. Hermes reads ACP toolsets from its process configuration; its dangerous-command approval bridge does not cover every mutation. No unsafe inference was launched. |
| GLM ACP | Enabled / ready, `glm-acp-agent@1.3.0` | Review blocked | Built-in writes/commands ask in default mode, but installed `sessionMcpTool` calls MCP without that gate. Session modes are not a universal native deny policy. No unsafe inference was launched. |
| Pi | Disabled at host; omitted | No verified per-session native tool filter through this host | Host schema exposes only session/RPC/extension timeouts, not tool filtering. No inference launched. |
| Copilot, Antigravity, Muse, Qwen | Disabled at host; omitted | Not evaluated for this change | No inference launched. |
| New/custom family | Host catalog decides | Blocked until an enforceable policy is verified | An arbitrary saved provider ID does not authorize unrestricted creation. |

OpenCode's first advertised model, `openai/gpt-5.3-codex-spark`, returned a real unsupported-model
account error. A separate explicitly selected `openai/gpt-6.2-sol` probe succeeded; Curator
never silently substitutes that model in production. Pin a model supported by your account.

## Tool-less skill context and data disclosure

OpenCode's wildcard deny also prevents skill reads. For this route only, Curator supplies
exact file contents from the same plugin-owned pre-review capture used for stale-write checks.
It adds at most **120,000 serialized characters**, with complete JSON file entries rather than
truncating individual files. Hidden path components, replacement characters, and non-whitespace
C0/C1 controls are omitted as common binary indicators. This heuristic is not a complete binary
classifier or secret filter. Other routes do not receive this additional bundle, including
when a failed source create is retried on a Claude/Codex fallback.

Snapshot entries are explicitly untrusted data. JSON escaping prevents closing the prompt's
data delimiter while preserving decoded content exactly, including `<`, `>` and `&`. The model
must decode content before copying patch text. Omitted files cannot be inspected with tools
on the tool-less route; the prompt tells the reviewer not to patch or remove them. The
complete plugin capture, not model assertions about reading, remains the mutation/version proof.

The bounded source turn, skill index, captured skill text and read-tool results can contain
file contents, credentials, secrets and personal data. Bounds and filters do **not** guarantee
redaction. The chosen provider receives them under its data policy and the user's account.
Trusted daemon plugins, launch hooks and provider extensions are part of the host trust boundary.
These controls are not a sandbox for trusted plugin code or remote services.

## Proven host/API limits and next step

The exact running AppImage's `app.asar` implementations were extracted read-only under
`/tmp/curator-pr7-source` and inspected alongside the installed provider implementations:

- `agent/provider-registry.js`: `toolPolicy` support is exact MCP **preapproval** for
  Claude/Codex/OpenCode. Other families reject it with `tool_policy_unsupported`. The protocol
  schema contains only `preapproved`; an empty list neither disables native tools nor adds grants.
- `providers/opencode/options.js`: scalar `permission: "deny"` becomes a wildcard
  `permission: "*", pattern: "*", action: "deny"` rule. Legacy `opencode-agent.js` forwards it
  into session create/resume; `opencode/v2/configuration.js` maps it to the v2 wildcard action.
  Both paths preserve deny-all without enumerating a finite set of native/extension tool names.
  `listControls` retains options; that response alone is not enforcement proof.
- `providers/omp/provider-config.js` and `agent.js`: strict options are `fast_mode`, `sessionDir`,
  `rpcTimeoutMs`, `smolModel`, `slowModel`, `planModel`. Launch modes supply approval flags and
  model roles, not caller-supplied `--no-tools`/`--tools`. Installed OMP supports such CLI flags,
  but Curator cannot request them through this per-session schema. Its installed approval
  resolver permits explicit tool/user allows before falling back to `always-ask`.
- `providers/pi/agent.js`: strict options are `sessionDir`, `rpcTimeoutMs`, `extensionTimeoutMs`.
  Session-open tool contributions add host tools; they do not replace a provider's built-ins.
- Installed Hermes `acp_adapter/session.py` resolves `platform_toolsets.acp` from process config;
  `permissions.py` bridges dangerous-command approvals. Process-global config/profile rewriting
  or a new isolated provider wrapper was not implemented or claimed safe in this scoped fix.
- Installed GLM `dist/tools/executor.js` asks before `writeFile`/`runCommand` in default mode,
  permits bypass/accept-edits modes, and executes session MCP tools without that check.

A universal tool-less SDK session is **not currently exposed** by this host. The bounded
upstream requirement is a validated per-session native-tool allowlist/deny-all option applied
before tool registration and covering built-ins, extensions, MCP, delegation, create and resume.
OMP/Pi can map it to their native tool controls; ACP integrations need an equivalent enforceable
session control or a separately configured isolated no-tools provider. Launch environment/MCP
injection alone is not that contract. This PR does not claim provider-agnostic completion.

[Paseo's provider-options reference](https://paseo.sh/docs/sdk/provider-options.md) documents
provider-specific option handling and merging. [OpenCode's permission reference](https://opencode.ai/docs/permissions/)
describes wildcard rules; v1 and v2 use different field names, handled by the inspected bridge.

## Reproducible verification and native UAT

The real SDK probes used the existing authenticated local daemon, real source turns, the actual
adapter/orchestrator/store/skill manager, and disposable cwd/skill roots and SQLite databases.
Queue rows were explicitly enqueued in those disposable stores to avoid the normal ten-tool
cadence. These are live provider runs, not tests of the installed plugin's production cadence.
The permission guard was reviewed before inference; the external probe denied any approval
requests for its own IDs. Only canary files in disposable roots were eligible write targets.
Probe agents were archived afterward. No real skill-library writes were requested or applied.

Evidence root: `/home/victor/.hermes/cache/scratch/curator-pr7-evidence/live-1795200580949`.
Each family has `source-timeline.json`, `review-timeline.json`, `canary-timeline.json`,
`config.json`, `canary.txt`, and `curator.sqlite`. `sqlite-readback.json` records read-only
terminal queries of queue and audit rows. Native tool results take precedence over model prose.
The daemon returned `projection: "projected"` even when canonical history was requested.

Automated regressions cover enabled-only discovery/refresh/selector omission, inactive saved
consent, no switch/send after disablement, late revocation, stripped native controls, exact
nested models, snapshot exactness, bounded payloads, binary/hidden omission, and fallback retries
in both directions. Existing filesystem/claim fencing and queue recovery checks remain in the
full suite. Browser fixture captures in `docs/screenshots/routing-harness-*` are historical
harness evidence and are not native UI evidence.

Native UAT after the authorized exact-SHA checkout update and curator-only reload:

1. Open native Settings → Plugins → Curator on host `vpc`.
2. Verify Curator routing shows Review provider and Refresh providers. Review model appears
   after selecting an available provider. The section has no provider status list or diagnostic disclosure.
3. Open Review provider and verify that it offers None and supported enabled routes. Blocked OMP,
   Hermes, GLM, and disabled families are absent. None remains the saved default.
4. Refresh: selection is preserved without a settings save. A host-disabled saved route is
   omitted from the menu; its generic inactive placeholder cannot authorize another route.
5. Clear to None to revoke fallback. Already transmitted reviews cannot be recalled.

The installed checkout is updated only after push, detached at the exact PR head, preserving
untracked files. Only curator is reloaded; the existing daemon is never restarted. Native
screenshots and the exact revision/CI result are recorded on PR7. Do not merge this PR.
