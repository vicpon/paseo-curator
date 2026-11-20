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
creation. Clearing, changing, invalidating or failing to read consent prevents pending sends.
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
or fail through the existing timeout/retry path. Curator does not auto-approve requests or
cancel stalled reviewer agents.

The selected provider receives a bounded source transcript and skill index under its own data
policy and the user's account settings. They may contain file contents, credentials, secrets
and personal data. Bounds do not redact sensitive content. Native tool results may also be
sent to that provider. The background reviewer runs in the source workspace.

The existing OpenCode route additionally receives up to 120,000 serialized characters of exact
captured skill-file text. Hidden paths and common binary indicators are omitted; this is not
secret detection. Other families do not receive this additional bundle. Snapshot entries and
the source transcript remain explicitly untrusted data in the prompt.

The user explicitly authorized removal of the provider eligibility and confinement policy.
Registry reviewers may reject this safety posture.

## Structured operation safeguards

Review JSON remains untrusted. Schema validation, path containment and symlink checks,
plugin-owned pre-review snapshots and stale checks, stable transaction locks, atomic writes,
rollback, claim fencing, provenance and audit remain in place. These apply to structured
operations applied by the plugin. They do not prevent native tools from changing files or
executing commands directly, and their locks do not exclude arbitrary external editors.
Reviewer IDs still include the route and queue attempt to prevent stale output reuse.

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
Live checks do not ask providers to write files or execute dangerous commands. Historical
confinement probes and browser fixture images from earlier PR7 revisions do not establish
current confinement. No current confinement claim is made. PR7 remains open and unmerged.
