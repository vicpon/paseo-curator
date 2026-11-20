Curator automatically turns lessons from completed Paseo work into reusable skills that future agents can use. It can preserve a corrected command, a debugging workflow that worked, or a missing tool constraint, so the next session can build on that result.

It does not create a skill after every turn. After a source agent accumulates **10 unique tool calls** across completed turns, Curator queues the threshold-crossing completed turn for a background review. The reviewer is instructed to prefer patching an existing skill before creating one. A review with no durable lesson records `nothing_to_save` and stays silent. Applied changes add **Self-improvement review — updated \<skills\>** to the source timeline; terminal failures add **Curator review failed**.

## Requirements and setup

- Paseo daemon and app with the plugin APIs used by SDK `0.16.0-beta.2`; the manifest declares `>=0.16.0-beta.2`. This minimum does not guarantee compatibility with future breaking releases. Native screenshots were checked on Linux with Paseo `0.17.0-beta.1`; macOS and Windows were not checked.
- Node.js **22.13.0 or later**, with built-in `node:sqlite`. Git preparation also needs npm on the daemon's PATH.
- An enabled, ready Paseo agent provider with working credentials, access to the selected model, and any CLI/runtime that provider requires. Reviews consume that provider's quota and may incur usage costs. Readiness alone does not verify credentials or model access.

Reviews first use the source agent's exact provider and model when available. In **Settings → Plugins → Curator**, **Review provider** selects an explicit alternative if the source route cannot run. It offers enabled, ready host providers, including custom providers. **None** is the default: it disables this alternative, not source-route reviews. **Review model** optionally pins a model; otherwise Curator resolves the selected provider's default. Refresh preserves selections. Disabled/unavailable choices cannot silently switch to another route.

Clearing or changing consent prevents a pending alternative send when settings are rechecked immediately before creation. Already submitted reviews cannot be recalled. If no route can run, Curator retries and eventually reports failure; that is different from `nothing_to_save`. Model discovery must succeed for the alternative route.

## Security and data

The receiving provider gets a bounded excerpt of the completed turn and a skill index containing names, descriptions and SKILL.md hashes. The excerpt can contain messages, reasoning, tool calls/results, file contents, credentials, secrets and personal information. Size limits do not redact sensitive content. OpenCode routes additionally receive captured skill-file text, bounded to **120,000 serialized characters**; hidden-path and non-text filters are not secret detection. Other routes do not receive that extra bundle.

The reviewer runs in the source workspace with **normal tool permissions**, including native file writes and commands. Tool results may also go to the provider under its data policy and your account settings. Curator does not enforce reviewer confinement or read-only execution. Its no-write prompt is advisory. The plugin itself is trusted, unsandboxed daemon code with filesystem, process and network access.

Path checks, version checks, locks, atomic writes and rollback apply **only to plugin-applied** structured operations, not the reviewer's native tool actions. Locks do not exclude external editors.

## Storage and limits

Skills live in `~/.agents/skills/`. Reviews can patch user-owned skills and add or remove their support files. Only skills marked `created_by: paseo-curator` can be archived by Curator; maintenance marks them stale after 14 inactive days and moves them to `.archive/` after 30, based on Curator's telemetry.

Queue, cadence, telemetry and audit metadata live in `~/.paseo/plugins/curator/curator.sqlite`; mutation intents and receipts live in `.paseo-curator/` under the skill root. Audits record outcomes, identifiers, skill names, counts and hashes, not raw review transcripts. Paseo and the provider separately retain agent history according to their own settings.

Defaults are one reviewer at a time, at most 20 proposed operations and three attempts. These values and storage paths are built in. Permission requests may stall a background review; Curator neither auto-approves nor cancels stalled reviewers. Ambiguous recovery needs manual reconciliation, and rollback uses UTF-8 text rather than byte-preserving binary restoration. Timeline notices do not survive daemon restart; durable audit outcomes remain.
