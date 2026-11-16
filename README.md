# Paseo Curator

Daemon-side automatic skill learning for Paseo. Completed source turns are counted by unique tool-call iteration; after the default threshold, an isolated curator reviews the exact turn and proposes structured skill operations. A plugin-owned manager validates and applies those operations under `~/.agents/skills/`.

## Requirements

- Paseo `0.16.0-beta.2` or later
- Node.js 22 or later (`node:sqlite`)

Curator agents inherit the source agent's provider route. The plugin does not require a specific provider, model, account, or local development harness.

## Install

```bash
npm install
npm test
npm run typecheck
paseo plugin install /absolute/path/to/curator
paseo plugin enable curator
paseo plugin reload curator
paseo plugin ls curator
```

The plugin is server-only; it has no client UI.

## Defaults

| Setting | Default |
|---|---:|
| Skill root | `~/.agents/skills/` |
| Review cadence | 10 unique tool iterations |
| Curator concurrency | 1 |
| Maximum operations | 20 |
| Maximum retries | 3 |
| Mark stale | 14 inactive days |
| Archive | 30 inactive days |
| Consolidation | Disabled |

These values are immutable defaults in version 0.1.0; operator settings are not exposed yet. State is stored in `~/.paseo/plugins/curator/curator.sqlite`. Durable state includes cadence counters, queue claims and retries, reconciliation cursor, skill telemetry, and a content-free append-only audit log. Applied-batch intents and receipts live under `.paseo-curator/` inside the default skill root.

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
