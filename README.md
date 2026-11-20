# Paseo Curator

Paseo agents often solve the same problems more than once: a brittle test command, an API quirk, a deployment check, or a debugging sequence that took several attempts to get right. Paseo Curator turns those verified lessons into reusable skills under `~/.agents/skills/`, where future agents can find them instead of rediscovering the same fix in a new session.

It brings Hermes-style automatic skill learning to the Paseo daemon, so learning is not tied to one foreground agent or session. It does **not** create a new skill after every turn. The plugin waits until a source agent has accumulated 10 tool calls, then reviews the completed turn for a lesson that is both reusable and proven to work. A review that finds no durable lesson ends with `nothing_to_save`. When there is something worth keeping, the curator prefers to update a relevant existing skill and creates a new one only when no existing skill fits.

For example, it can preserve:

- a corrected command or setup step that fixed a recurring failure;
- a reliable debugging workflow that produced a verified result;
- a project or tool constraint that an existing skill omitted;
- a repeatable sequence that should become a checklist or helper script.

The curator returns structured proposals such as "create this skill," "replace this exact text," or "remove this support file." The plugin checks paths, provenance, pre-review file versions, operation limits, and rollback safety before applying them. User-owned skills can be patched and their support files removed. Only archival is restricted to curator-created skills.

## Requirements

- Paseo `0.16.0-beta.2` or later
- Node.js 22 or later (`node:sqlite`)

Reviews preserve the exact source provider/model when native read-only controls are available. Codex uses its native read-only sandbox; Claude exposes only Read, Glob and Grep and denies all MCP tools. Session mode names are not used as safety controls. Other installed providers remain visible with an unavailable reason. See [routing controls and acceptance matrix](docs/routing.md).

## Install

### From GitHub

```bash
paseo plugin install git:vicpon/paseo-curator
paseo plugin enable curator
paseo plugin reload curator
```

Verify that the daemon loaded it:

```bash
paseo plugin ls curator --json
paseo plugin logs curator --json
```

The plugin entry should show `"enabled": true` and `"status": "running"`. The logs should end with `Plugin ready`.

To update or remove it later:

```bash
paseo plugin update curator
paseo plugin reload curator

# Disable without deleting its state:
paseo plugin disable curator

# Remove the plugin registration:
paseo plugin remove curator
```

### From a local checkout

Use this when developing or testing an unpublished change:

```bash
git clone https://github.com/vicpon/paseo-curator.git
cd paseo-curator
npm ci
npm test
npm run typecheck
paseo plugin install "$PWD"
paseo plugin enable curator
paseo plugin reload curator
paseo plugin ls curator --json
```

The plugin runs its learning pipeline on the server and adds a small client renderer for curator activity cards. Paseo plugins are trusted and unsandboxed. Review the code before installing it: this plugin is intentionally allowed to update the configured skill library.

## Configuration

In Settings → Plugins → Curator, **Fallback provider** discovers the host's catalog. **None** (default) disables fallback. Selecting an enabled, available provider with supported native controls explicitly authorizes transmission to that provider when the exact source route cannot run. **Fallback model** can follow that provider's default or pin a model. The screen discloses what is sent; refresh preserves both selections, including unavailable ones, without saving. Unsupported providers have disabled controls and specific reasons.

Provider and model consent are read fresh immediately before fallback creation. Clearing, changing, invalidating, or failing to read settings prevents a pending fallback from sending; submitted reviews cannot be recalled. Version 1's explicit Codex selection migrates unchanged; invalid legacy values become None. New provider IDs are stored without a fixed provider enum, but unknown native policies still fail closed.

Other values remain built in:

| Setting | Default |
|---|---:|
| Skill root | `~/.agents/skills/` |
| State database | `~/.paseo/plugins/curator/curator.sqlite` |
| Review cadence | 10 unique tool iterations |
| Curator provider | Exact source route when supported; explicit fallback only |
| Curator confinement | Provider-native sandbox or restricted read-only tools |
| Curator concurrency | 1 |
| Maximum operations per review | 20 |
| Maximum retries | 3 |
| Mark curator-created skills stale | 14 inactive days |
| Archive curator-created skills | 30 inactive days |
| Consolidation | Disabled |

Overrides for the built-in values require a source change and plugin reload. Fallback never selects another provider automatically. If no permitted route exists, the attempt raises `source-model-unavailable`, retries within the existing budget, and eventually fails with a timeline notice. This is not a successful skip or a `nothing_to_save` verdict.

Durable state includes cadence counters, queue claims and retries, reconciliation cursor, skill telemetry, and a content-free audit log. Migration preserves existing `nothing_to_save` outcomes and future exact outcomes, but cannot reconstruct no-op records that older versions already discarded or rewrote. Applied-batch intents and receipts live under `.paseo-curator/` inside the skill root.

## What is sent to providers

The curator prompt contains a bounded excerpt of one completed source turn plus an index of the shared skill library. It can include user and assistant messages, reasoning, tool calls and output, file contents, credentials, secrets, and personal information already present in that turn. The size bounds do not redact sensitive data, and there is no no-credentials or no-file-contents guarantee.

The background agent runs in the source workspace. Read tools can inspect skills and workspace files; their results can be sent to the selected provider too. The provider configured for the selected route receives the prompt and tool results under its own data policy and your account settings. The plugin is trusted, unsandboxed daemon code with the daemon user's filesystem and network access.

## How it triggers

1. Complete normal work in a Paseo agent.
2. The plugin accumulates unique tool-call iterations for that source agent.
3. At 10 accumulated iterations, it queues the completed turn for review.
4. A background curator proposes zero or more structured skill operations.
5. The plugin either records `nothing_to_save` or validates and atomically applies the operations.

## What you see in Paseo

The curator stays quiet when a review finds nothing reusable. It does not add a “no reusable lesson found” message to your timeline.

When a review makes a real change, a single muted subtext line appears in the source agent's timeline — **Self-improvement review — updated \<skills\>** — listing the affected skill names (and change count when more than one). If a review exhausts its retries or reaches a terminal safety failure, a compact danger-colored line — **Curator review failed** — appears instead. These notices are appended only after the durable queue state has been updated; notification failure cannot change the review outcome.

Use these commands while testing:

```bash
paseo plugin logs curator --json
paseo ls --json
```

To inspect the latest durable outcomes without requiring the `sqlite3` CLI:

```bash
node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(
  process.env.HOME + "/.paseo/plugins/curator/curator.sqlite",
  { readOnly: true },
);

console.table(db.prepare(`
  SELECT source_agent_id, turn_id, status, attempts, completed_at, error
  FROM queue
  ORDER BY created_at DESC
  LIMIT 10
`).all());

console.table(db.prepare(`
  SELECT source_agent_id, turn_id, outcome, operation_count,
         skill_names_json, rejection_reason, created_at
  FROM audit_log
  ORDER BY id DESC
  LIMIT 10
`).all());
NODE
```

A successful review ends with queue status `nothing_to_save` or `applied`. An `applied` row with a positive `operation_count` should correspond to a created or patched skill under `~/.agents/skills/`.

## Safety and recovery

- Curator output is untrusted JSON. The plugin validates proposed mutations; the reviewing agent can still use provider read tools.
- The plugin captures byte-exact skill versions before review, then compares touched skills under its locks before any mutation, including `remove_file`. Model-supplied read sets are advisory; the model need not echo files or compute hashes. Changes after capture reject the batch. These locks coordinate plugin batches, not arbitrary external editors.
- Paths are contained within the canonical skill root; symlink swaps are checked again at mutation and rollback time.
- Batches use stable locks, snapshots, atomic file writes, and rollback.
- A pre-mutation intent journal reconciles crashes between filesystem commit and SQLite queue completion without rerunning nondeterministic curator output.
- Queue claims use attempt-generation fencing; stale attempts cannot complete newer claims and are checked during filesystem application.
- Timeline reset, gap, stale cursor, epoch changes, and non-progressing pagination are rejected.
- Curator agents are excluded from their own lifecycle. The plugin requests verified native confinement options and refuses providers without them. Its permission guard denies requests that reach Paseo; this hook alone does not confine native tools. Agent IDs include the route and queue attempt and are registered before creation. A retry starts a fresh review against its new pre-review capture; it cannot reattach to output based on an earlier capture. No live provider confinement test was performed for this change.
- Source-turn entries and skill-index descriptions are explicitly delimited as untrusted data; curator agents are instructed never to execute quoted commands or tasks.
- Automatic maintenance archives only skills whose frontmatter says `created_by: paseo-curator`. User and externally installed skills are protected from archival, but reviews can patch them or remove their support files.
- Prompts, transcripts, raw model output, secrets, and PII are not persisted in errors or audit records.

Native controls and their inspected upstream implementations are documented in the [routing acceptance matrix](docs/routing.md). Source inspection and adapter tests do not establish live provider confinement; no live review or plugin reload was performed for this change. Existing rollback snapshots store UTF-8 text, so rollback restoration of binary assets is not byte-preserving; version checks compare raw bytes.

## Recovery behavior

When the first lifecycle hook supplies the Paseo API after plugin load, the plugin:

1. recovers stale `running` queue rows;
2. reconciles durable filesystem intents/receipts before any curator rerun;
3. drains pending work;
4. scans a bounded set of recent idle-agent timeline tails to recover missed live hooks;
5. runs deterministic maintenance when enabled.

Ambiguous mixed filesystem state and failed rollback are terminalized as reconciliation-required rather than replayed automatically.

## Attribution

The review methodology is adapted from Hermes by Nous Research under the MIT License. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
