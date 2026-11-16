# Paseo Curator

Daemon-side automatic skill learning for Paseo. Completed source turns are counted by unique tool-call iteration; after the default threshold, an isolated curator reviews the exact turn and proposes structured skill operations. A plugin-owned manager validates and applies those operations under `~/.agents/skills/`.

## Requirements

- Paseo `0.16.0-beta.2` or later
- Node.js 22 or later (`node:sqlite`)

Curator agents inherit the source agent's provider route. The plugin does not require a specific provider, model, account, or local development harness.

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

The plugin is server-only; it has no client UI. Paseo plugins are trusted and unsandboxed. Review the code before installing it: this plugin is intentionally allowed to update the configured skill library.

## Configuration

No configuration is required after installation. Version 0.1.0 uses the following built-in settings:

| Setting | Default |
|---|---:|
| Skill root | `~/.agents/skills/` |
| State database | `~/.paseo/plugins/curator/curator.sqlite` |
| Review cadence | 10 unique tool iterations |
| Curator provider | Inherit the source agent's provider route |
| Curator mode | `ask` |
| Curator concurrency | 1 |
| Maximum operations per review | 20 |
| Maximum retries | 3 |
| Mark curator-created skills stale | 14 inactive days |
| Archive curator-created skills | 30 inactive days |
| Consolidation | Disabled |

Operator overrides are not exposed through `paseo-plugin.json` in version 0.1.0. Changing these values currently requires a source change and plugin reload. Curator agents inherit the full provider/model route recorded on the source turn, so the corresponding provider must be enabled in Paseo and support the `ask` mode.

Durable state includes cadence counters, queue claims and retries, reconciliation cursor, skill telemetry, and a content-free append-only audit log. Applied-batch intents and receipts live under `.paseo-curator/` inside the skill root.

## How it triggers

1. Complete normal work in a Paseo agent.
2. The plugin accumulates unique tool-call iterations for that source agent.
3. At 10 accumulated iterations, it queues the completed turn for review.
4. A background curator proposes zero or more structured skill operations.
5. The plugin either records `nothing_to_save` or validates and atomically applies the operations.

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

- Curator output is untrusted JSON and never receives direct filesystem access.
- Existing files require exact read-before-write evidence.
- Paths are contained within the canonical skill root; symlink swaps are checked again at mutation and rollback time.
- Batches use stable locks, snapshots, atomic file writes, and rollback.
- A pre-mutation intent journal reconciles crashes between filesystem commit and SQLite queue completion without rerunning nondeterministic curator output.
- Queue claims use attempt-generation fencing; stale attempts cannot complete newer claims and are checked during filesystem application.
- Timeline reset, gap, stale cursor, epoch changes, and non-progressing pagination are rejected.
- Curator agents are excluded from their own lifecycle. They run in Paseo's `ask` mode: read-only inspection remains available, while every approval-gated action is denied by a plugin-owned permission guard. A deterministic agent ID is registered before creation, closing the first-permission race without trusting user-controlled labels.
- Source-turn entries and skill-index descriptions are explicitly delimited as untrusted data; curator agents are instructed never to execute quoted commands or tasks.
- Automatic maintenance never deletes. It archives only skills whose frontmatter says `created_by: paseo-curator`; user and externally installed skills are protected.
- Prompts, transcripts, raw model output, secrets, and PII are not persisted in errors or audit records.

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
