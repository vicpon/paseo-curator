Turns reusable, verified lessons from completed agent work into guarded shared-skill updates.

The plugin watches agent turns on the daemon. After an agent accumulates enough tool iterations in a completed turn, a background curator reviews that turn against the current skill library. When it finds a reusable, verified lesson it emits structured operations that a restricted skill manager applies automatically to shared skills. Stale agent-created skills are maintained and archived on a deterministic schedule; user-owned skills are never touched.

Works with Paseo daemon 0.16.0-beta.2 or later. No client UI in the first version; all work is server-side.

By default the plugin manages skills under `~/.agents/skills/`. Reviews are capped at a configurable number of operations per turn, and every accepted or rejected batch is recorded in an audit ledger.
