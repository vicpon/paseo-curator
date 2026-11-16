# Paseo Curator Plugin Design

## Intent

Build a trusted, daemon-side Paseo plugin that gives Paseo agents Hermes-style procedural learning without user intervention. Completed coding-agent turns are reviewed in the background; reusable, verified lessons become shared skills under `~/.agents/skills/`; stale agent-created skills are maintained without deleting user-owned material.

## Goals

- Trigger learning from Paseo lifecycle events, not from an agent remembering to invoke a skill.
- Match Hermes' default cadence: review after 10 accumulated tool iterations rather than paying for every trivial turn.
- Reuse Hermes' learning signals and prompt methodology: corrections, working fixes, non-trivial workflows, and loaded skills found incomplete or wrong.
- Apply skill changes automatically through a restricted skill manager with no approval prompt.
- Survive daemon/plugin restarts and avoid duplicate reviews or recursive curator runs.
- Preserve source attribution for MIT-licensed Hermes-derived methodology.

## Non-goals

- General autobiographical/user memory; this plugin manages procedural skills only.
- A UI in the first version.
- Directly porting Hermes' Python runtime or coupling Paseo to Hermes.
- Letting curator agents run arbitrary shell commands against the skill library.
- Automatically deleting skills.

## Constraints

- Target Paseo `>=0.16.0-beta.2` and its current TypeScript plugin SDK.
- Server-only trusted plugin using `index.server.ts`.
- Default skill root: `~/.agents/skills/`.
- `agent.turn.after` delivery is live and best-effort, concurrent, and not replayed; the plugin must add durable idempotency and startup reconciliation.
- Curator-generated turns must be tagged and excluded from the trigger.
- All writes must stay inside the configured skill root after realpath resolution.

## Approaches Considered

### 1. Curator edits files directly

Smallest implementation, but provider agents would have unrestricted filesystem behavior, no atomic rollback, and inconsistent behavior across provider implementations. Rejected.

### 2. Proposal-only curator with human approval

Safest mutation policy, but it is not Hermes-like autonomous learning and would create approval fatigue. Rejected by the requirement for no user intervention.

### 3. Guarded autonomous curator — selected

The background curator emits structured operations. The plugin validates and applies them automatically with read-before-write, path containment, atomic batches, backups, provenance, and an audit ledger. This reproduces Hermes' `background_review → skill_manage → curator` architecture while fitting Paseo's plugin runtime.

## Architecture

### Turn capture and durable queue

`agent.turn.after` receives successful, failed, and cancelled outcomes. Only completed source-agent turns qualify. The hook fetches the exact whole turn from the agent timeline, counts tool iterations, and updates a durable per-agent counter. At 10 accumulated tool iterations it enqueues a review and resets the counter only after durable enqueue.

Queue records are keyed by `sourceAgentId + turnId`. They move through `pending`, `running`, `applied`, `nothing_to_save`, and `failed` states. A local SQLite database under the plugin state directory stores queue, counters, skill telemetry, and audit entries. A startup/interval reconciliation pass scans recent non-curator agent timelines so best-effort hook loss does not permanently skip eligible turns.

### Curator agent

The plugin creates one background Paseo agent per queued review, inheriting the source agent's provider/model when possible and using the source working directory. Metadata and labels identify it as a curator and link it to the source agent/turn. The prompt contains a bounded transcript of the exact source turn plus the current skill index.

The methodology follows Hermes:

- prefer patching a relevant loaded/existing class-level skill;
- create a new class-level skill only when no existing skill fits;
- capture user corrections, verified fixes, reusable workflows, and missing skill steps;
- never encode unresolved failures, secrets, raw transcripts, or one-off task narratives;
- return `nothing_to_save` when no reusable verified lesson exists.

The curator has no direct skill-library write authority. It returns one JSON document containing a summary and up to 20 operations.

### Skill manager

Supported operations:

- `create`: create a new `SKILL.md` with YAML frontmatter;
- `patch`: unique exact-text replacement in `SKILL.md` or a support file;
- `write_file`: create a new file only under `references/`, `templates/`, `scripts/`, or `assets/`;
- `remove_file`: remove an agent-created support file;
- `archive`: move an agent-created skill into `.archive/` during maintenance.

Every batch is validated before mutation. Existing targets must have been included in the curator's read set. Names, frontmatter, sizes, operation count, file types, path containment, symlink traversal, duplicate/destructive operations, and provenance are checked. The manager snapshots every touched skill, applies via temporary files and atomic rename, and restores all snapshots if any operation fails. Every accepted or rejected batch is recorded in the audit ledger.

Existing user/shared skills may be patched after exact read-before-write, matching Hermes. Autonomous archive is restricted to skills carrying `created_by: paseo-curator`; user-created and externally installed skills are never archived.

### Maintenance curator

A periodic idle maintenance pass tracks `view_count`, `patch_count`, `use_count`, `last_activity_at`, `state`, and provenance. It marks agent-created skills stale after 14 days and archives them after 30 days. It never deletes. Consolidation is disabled by default because it requires an additional model pass; the deterministic lifecycle sweep remains enabled.

### Recursion and concurrency controls

- Ignore agents carrying `paseo.curator=true` metadata or curator labels.
- Use queue uniqueness constraints for event deduplication.
- Limit curator concurrency to one by default.
- Serialize batches touching the same skill.
- Treat plugin shutdown or interrupted curator runs as retryable queue states.
- Cap retries and record terminal failures instead of looping.

## Testing

Use Vitest with test-first development. Unit tests cover eligibility/cadence, queue idempotency, prompt/result validation, path and symlink defenses, read-before-write, atomic rollback, provenance/archive rules, recursion exclusion, and retry limits. Integration tests use a fake Paseo SDK/context to exercise `agent.turn.after → enqueue → curator completion → skill update`. Final verification includes typecheck, full tests, packaging, local Paseo installation, plugin reload, and a controlled end-to-end turn that creates or patches a temporary skill in an isolated test root.

## Security and licensing

The plugin is trusted and unsandboxed, so all model output is untrusted input. No curator output becomes a path or write without canonicalization and validation. Logs redact transcript content and retain identifiers, decisions, and hashes. Hermes-derived methodology and any substantially adapted code retain the Nous Research MIT copyright and license notice; new plugin code may use MIT as well.
