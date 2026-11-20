# Provider routing controls and acceptance

Curator discovers providers from the selected host's SDK `providers.waitForReady().entries`.
Provider IDs, enabled flags, availability and labels come from that catalog; neither discovery
order nor a preferred provider chooses a route. Native confinement has small provider-specific
adapters. Unknown families remain visible and unavailable until their controls are verified.
No mode label is evidence of safety.

## Routing contract

1. Keep the exact source provider/model (including nested model IDs) if it is enabled,
   available and has verified native controls. Never substitute a source model's default.
2. Otherwise, only an explicitly saved fallback provider can receive the review. None is
   the default. A pinned fallback model must still exist; an unset model follows the explicitly
   chosen provider's default, then its first advertised model. There is no provider preference order.
3. Resolve native options with `providers.listControls` for the exact route and cwd; require
   the effective options to retain the required restrictions. Missing API, error or stripped
   options fails closed. Create passes SDK `config.options`, not daemon `providerOptions` or
   invented session mode IDs. Empty tool-policy preapprovals grant no extra MCP tools.
4. Recheck enabled/available status and provider/model consent immediately before create.
   Changing, clearing, invalidating or failing to read settings cancels the pending fallback.
   Already submitted requests cannot be recalled. No provider/model catalog refresh saves settings.
5. Route and policy participate in reviewer identity, alongside the source turn and review
   attempt. Plugin-owned pre-review snapshots and apply-time claim/version fencing are unchanged.

## Acceptance matrix

Observed host: desktop-managed Paseo 0.16.2, standard `paseo provider ls --json`, 2026-11-20.
The installed SDK is `@getpaseo/client`/`plugin`/`protocol` 0.16.0-beta.2. No daemon was started,
plugin reloaded, or live installed checkout edited. Availability is discovery, not authentication
or a successful model request.

| Route family | Observed catalog | Curator safety policy | Validation / limitation |
|---|---|---|---|
| Codex | Enabled, available; modes Default Permissions, Auto-review, Full Access | `options: {sandbox_mode: "read-only", approval_policy: "never"}` | Adapter tests assert native options with no `modeId`; source/provider forwarding inspected. No live write-confinement probe. |
| Claude | Enabled, available | `extraArgs.tools: "Read,Glob,Grep"`, corresponding `allowedTools`, `disallowedTools: ["mcp__*"]` | Native built-in tool restriction plus all MCP tools denied; allowedTools alone is not an allowlist. Adapter tests cover source and explicit fallback. No live write-confinement probe. |
| OMP | Enabled, available | Disabled | Host only exposes approval modes (`full`, `write`, `ask`) and session/model/runtime options, not native tool filtering or a read-only sandbox. Upstream must expose and enforce a native allowlist/sandbox, including custom tools, before this route can run. |
| OpenCode | Enabled, available | Disabled | Host supports scalar deny-all or a strict fixed-key permission object. Deny-all also prevents required skill reads; enumerating native write permissions leaves extension tools unconfined. Upstream needs a deny-by-default read-tool allowlist covering extension/MCP tools. |
| Hermes | Enabled, available, ACP | Disabled | Host ACP route exposes session modes, not a verified read-only toolset or sandbox control. Hermes modes are Default, Accept Edits, Don't Ask. Its approval bridge is for dangerous commands, not every native mutation. Upstream needs an enforceable per-session toolset/sandbox control through ACP/Paseo. |
| GLM ACP | Enabled, available | Disabled | No verified native confinement contract; ask/auto/bypass labels are insufficient. |
| Copilot, Pi, Antigravity, Muse, Qwen Code | Disabled, unavailable | Disabled | Catalog entries retained with disabled/unavailable reason. |
| New/custom provider | Host catalog decides | Disabled until native policy verified | Its ID can persist in settings without becoming an authorized runnable route. |

Trusted daemon plugins, provider startup hooks and operator-managed external services remain
part of the host trust boundary. These controls restrict reviewer native mutation tools, not
the trusted Curator plugin that applies validated skill proposals. Codex filesystem sandboxing
is not a sandbox for remote MCP services. The permission guard continues to deny approval-gated
requests, but is not used as the sole proof of native write confinement.

## Verified implementation evidence

The shipped Paseo 0.16.2 `app.asar` provider option implementations were read directly,
without executing the daemon. Upstream tag `v0.16.2` resolves to
`2ee30f4164af42ba209236ab3a31bf9532592fc3`; its option schemas were also fetched from GitHub.

- [Installed SDK contract](../shared/routing.ts) follows the installed client's `PaseoAgentConfig`
  (`options`, `toolPolicy`) and `PaseoProviderActions` (`waitForReady`, `listControls`). The
  actual snapshot shape is `entries: [{provider, status, enabled, ...}]`, not a guessed
  `{providers: [{id, available}]}`. The SDK maps `config.options` to daemon `providerOptions`.
- [Codex options](https://github.com/getpaseo/paseo/blob/2ee30f4164af42ba209236ab3a31bf9532592fc3/packages/server/src/server/agent/providers/codex/options.ts)
  validates `sandbox_mode` and `approval_policy`. The [Codex agent](https://github.com/getpaseo/paseo/blob/2ee30f4164af42ba209236ab3a31bf9532592fc3/packages/server/src/server/agent/providers/codex-app-server-agent.ts)
  forwards provider options into native thread configuration and preserves explicit sandbox
  settings rather than substituting workspace-write mode presets.
- [Claude options](https://github.com/getpaseo/paseo/blob/2ee30f4164af42ba209236ab3a31bf9532592fc3/packages/server/src/server/agent/providers/claude/options.ts)
  accepts `extraArgs`, `allowedTools` and `disallowedTools`; [buildOptions](https://github.com/getpaseo/paseo/blob/2ee30f4164af42ba209236ab3a31bf9532592fc3/packages/server/src/server/agent/providers/claude/agent.ts)
  passes them to the Claude Agent SDK. Installed `claude --help` documents `--tools` as the
  built-in availability filter. [Anthropic's CLI reference](https://code.claude.com/docs/en/cli-reference)
  and [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions) document deny
  globs, including `mcp__*`, and deny-rule precedence over hooks, allows and bypass mode.
- [OMP schema and launch mapping](https://github.com/getpaseo/paseo/blob/2ee30f4164af42ba209236ab3a31bf9532592fc3/packages/server/src/server/agent/providers/omp/provider-config.ts)
  only pass approval-mode flags and model roles. [OpenCode options and rules](https://github.com/getpaseo/paseo/blob/2ee30f4164af42ba209236ab3a31bf9532592fc3/packages/server/src/server/agent/providers/opencode/options.ts)
  show the fixed permission keys and scalar wildcard deny. These are host API blockers,
  not a statement that the underlying CLIs can never support read-only operation.
- Hermes standard CLI diagnostic identifies `hermes acp`, successful ACP initialization,
  three modes and 57 models; the version probe timed out. Local installed
  `~/.hermes/hermes-agent/acp_adapter/modes.py`, `session.py` and `permissions.py` were inspected.
  No model prompt was submitted. No claim of authenticated, completed Hermes review is made.

SHA-256 of the extracted installed JavaScript evidence (kept outside the repository):
Claude options `d673c9227db4605221edd8aebafb0691ea53b638ec5189fc68a3247751b163d8`;
Codex options `a6a5bdf3bff36fa624e28aad3a9b1bf3e7333f3b4ac6b813dec48159f03ed061`;
OMP config `d8f07cfcd808c38a15dfd1a5b27f8958f03c1f97071c609c8f62872f9a146e43`;
OpenCode options `bfcdb7ae324e810690d003253bbb49e5bb299a7ca8b4d2540e9488457d27219c`.

## Settings migration and UI validation

Version 2 preserves explicit v1 Codex consent and defaults invalid legacy values to None.
Current provider IDs are validated structurally, not against a provider enum. A fallback model
requires a provider. Provider/model values survive discovery errors and refreshes; disappearing
entries retain their saved values and fail closed at routing time. Host revision-based saves
remain in use, so stale UI revisions cannot overwrite newer settings.

Automated regressions exercise discovery order, enabled filtering, unknown policies, native
controls, exact nested source routes, explicit provider/model selection, pending revocation,
missing/stripped controls, v1 migration, and settings UI interaction/refresh/error states.
Existing stale-write, delete, claim-fencing and recovery regressions run in the full suite.

Genuine browser screenshots were captured and inspected at 1280px and 375px widths using
[the testable harness](../tests/ui/README.md), rendering the actual settings component with
HTML host-control substitutes and clearly labeled catalog/model fixtures. Selection survived
provider refresh and browser reload; 375px document width equaled its viewport width.
[Desktop](screenshots/routing-harness-desktop.png) and [compact](screenshots/routing-harness-mobile.png) captures retain the fixture notice.
This verifies the browser harness only. Native Paseo UI, host settings persistence across
plugin reloads, and end-to-end provider confinement remain untested: `orca-ide` is absent,
Paseo exposes no CDP port, and the user prohibited plugin reload/deployment. No native UI
screenshot is claimed. Run `npm run preview:settings` to reproduce the testable artifact.

UAT after a separately authorized installation: open Settings → Plugins → Curator; confirm
None default and the full provider status list, choose a supported provider and pin a model,
refresh and reopen settings, then clear fallback. Verify source routing, explicit fallback,
provider disablement and a pending consent revocation against disposable data before trusting
live confinement. Do not use the browser fixture as evidence that a native provider denied writes.
