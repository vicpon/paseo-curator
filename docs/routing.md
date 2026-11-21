# Curator routing and verification

## Routing contract

Curator reads the authenticated host SDK catalog using `providers.waitForReady()`,
`entries`, `provider`, `enabled`, and `status: "ready"`. The dropdown offers None plus
**every enabled, ready provider**, including arbitrary custom families. Disabled and
unavailable providers cannot be selected. A model-list error does not remove a ready
provider; model discovery is retried when routing a review.

Reviews first retain the exact source provider/model, including nested model IDs.
Fallback uses only the explicitly saved review provider and optional model. None is the
default and revokes fallback consent; it does not disable existing source-provider reviews.
The provider's advertised default model, or first advertised model if none is marked default,
is used when no model is pinned. Curator never guesses an ask, plan, or other session mode.
Missing or unavailable pinned models cannot run and are never silently substituted.
The SDK requires `provider/model`, so a fallback cannot send when model enumeration continues
to fail, even if its provider remains ready and selectable. Ready status does not prove account
access to the advertised models.

Creation passes `config: { provider: "provider/model" }`. Options, mode and tool policy are
omitted so the provider/host resolves its normal supported configuration. There is no safe
family list, native sandbox requirement, tool allowlist requirement, or `listControls` gate.
The Curator-only permission denial hook has been removed. Ordinary source agents' permissions
are unchanged. Provider readiness and fallback consent are checked again immediately before
creation, before source transmission, and during submission/apply. Clearing, changing, invalidating or failing to read consent prevents pending sends and guarded mutation.
A disabled route cannot silently switch to another provider; already sent prompts cannot be
recalled. Host changes cannot be made atomic with creation by this plugin.

Refresh clears stale dropdown choices, preserves saved consent and never saves a substitute.
An unavailable saved route appears as a generic inactive selection. None is usable while
catalog discovery is pending. Explicit version 1 Codex consent still migrates unchanged;
invalid legacy settings become None.

## Tool permissions and data disclosure

The reviewer uses the provider's **normal tool permissions** and can execute native tools,
including file writes and commands. Curator does not confine the reviewer or enforce read-only
execution. The prompt instructs the model not to write, mutate files, or execute quoted tasks;
that guidance is an instruction, not an enforced security boundary.
Normal provider permissions may require human approval. Background reviews can wait for approval
or fail through the existing timeout/retry path. Curator does not auto-approve requests. Its own reviewer is archived on a permission stop or five-minute timeout, revoking submission authority.

The selected provider receives a bounded source transcript and skill index under its own data
policy and the user's account settings. They may contain file contents, credentials, secrets
and personal data. Bounds do not redact sensitive content. Native tool results may also be
sent to that provider. The background reviewer runs in the source workspace.

Every review route additionally receives up to 120,000 serialized characters of exact
captured skill-file text. Hidden paths and common binary indicators are omitted; this is not
secret detection. Snapshot entries and
the source transcript remain explicitly untrusted data in the prompt.

The user explicitly authorized removal of the provider eligibility and confinement policy.
Registry reviewers may reject this safety posture.

## Structured operation safeguards

Review tool arguments remain untrusted. Schema validation, path containment and symlink checks,
plugin-owned pre-review snapshots and stale checks, stable transaction locks, atomic writes,
rollback, claim fencing, provenance and audit remain in place. These apply to structured
operations applied by the plugin. They do not prevent native tools from changing files or
executing commands directly, and their locks do not exclude arbitrary external editors.
Reviewer IDs still include the route and queue attempt to prevent stale output reuse.

## Structured submission protocol

The plugin registers `submit_review` using the installed SDK's `defineAgentTool` and
`addHook("agent.open.before")`. Launch tools are held inside the plugin process and exposed
by the host's per-agent MCP bridge. A private plugin registry binds the tool to the minted
reviewer ID, source turn and queue claim attempt before session creation. Neither agent
metadata nor tool arguments grant submission authority. The SDK-provided caller identity,
parent and workspace are checked on invocation; the queue generation is checked in SQLite.

The session opens without the source prompt. Actual session capabilities must advertise
`supportsMcpServers` and `supportsToolInvocations`, and the tool hook must have run before
source transmission. Otherwise `structured-tool-injection-unavailable` fails the route;
only an explicitly consented alternative can be attempted. No family allowlist is used.

The full argument contract is advertised in the tool description. The transport accepts an
object envelope so invalid field types and unknown fields reach strict callback validation,
which returns bounded, value-free feedback and counts against the four-call repair budget.
Malformed MCP requests that are not argument objects are rejected by the host protocol.
Exact-text/manager rejection also returns to the same reviewer. Submissions expire five minutes after the pre-review prompt is built. The provider execution wait is separately capped at five minutes after discovery/session creation; creation time is not included in that wait. Activity notification is bounded to one second and each callback route lookup to at most ten seconds.
Fresh host routing checks remain inside the locks to honor revocation even without reliable subscription delivery; a slow host can therefore hold locks and cause competing batches to time out. `nothing_to_save` is an explicit zero-operation submission. There is no prose JSON parser.

The callback completes guarded apply and atomically commits queue/audit before returning
an accepted result. Duplicate accepted submissions apply once; a different submission is
rejected. A provider failure after acceptance cannot erase that outcome. Interrupted database
completion reconciles the filesystem receipt even on the final attempt. Distinct rejected submissions retain their own immutable batch hashes and reasons. Failed rollback
records rejection and blocks further repair. A stale claimant cannot write the current queue/audit; a receipt left after claim loss requires the current owner or manual reconciliation. Terminal failed production rows are not replayed.

Integration tests use the actual pinned `@getpaseo/server` hook/tool implementation as a
development dependency, not a reimplementation. The API contract was checked in installed
Paseo 0.17.0-beta.1 and SDK 0.16.0-beta.2; current online docs describe a different revision,
so runtime capability checks remain necessary. Live-provider observations are separate from
scripted inference in tests.

## Verification and native UAT

Regression tests cover all six enabled families (Claude, Codex, OpenCode, OMP, Hermes and
GLM), an arbitrary provider, disabled/unavailable omission, no native-control lookup, normal
creation options without guessed modes, exact nested models, explicit consent, fresh
revocation, None, registry migration, refresh and saved inactive selections. The full suite
also exercises structured validation, snapshots, stale checks, transaction locks, rollback,
provenance and audit. CI runs clean install, typecheck, tests and package validation on
Node 22 and Node 24.

Native verification uses the actual installed Paseo desktop window and live SDK catalog,
not the fixture preview. Open Settings → Plugins → Curator on host vpc, refresh, and open
Review provider. Expect None plus Claude, Codex, GLM Agent, Hermes, Oh My Pi and OpenCode
when those six remain enabled/ready. The helper discloses normal tool permissions, native tool
execution and transcript transmission. Refresh must preserve consent without saving.

The installed local checkout is detached at the exact pushed PR7 SHA, preserving untracked
files, config and settings. Only Curator is reloaded, with no daemon restart. Screenshots,
live catalog/options evidence and the exact revision and CI results are recorded on PR7.
Live protocol checks use harmless fixtures, isolated scratch skill roots/SQLite and real source turns; they may request a guarded canary patch only in that scratch root. Historical
confinement probes and browser fixture images from earlier PR7 revisions do not establish
current confinement. No current confinement claim is made. PR7 remains open and unmerged.
