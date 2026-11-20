Turns reusable, verified lessons from completed agent work into guarded shared-skill updates.

The plugin watches agent turns on the daemon. After an agent accumulates enough tool iterations in a completed turn, a background curator agent reviews that turn against the current skill library. When it finds a reusable, verified lesson it emits structured operations that a restricted skill manager applies automatically to shared skills. Stale agent-created skills are maintained and archived on a deterministic schedule; user-owned skills are never touched.

Works with Paseo daemon 0.16.0-beta.2 or later. The plugin runs server-side and renders a single muted activity line in the source agent's timeline when a review makes a change.

By default the plugin manages skills under `~/.agents/skills/`. Reviews are capped at a configurable number of operations per turn, and every accepted or rejected batch is recorded in an audit ledger.

## What the curator agent receives

The curator runs as a background Paseo agent. It receives a prompt containing a bounded excerpt of the source agent's completed turn — the tool calls and assistant messages from that turn — and a read-only index of the current skill library. It does not receive full conversation history, credentials, file contents, or data from other turns.

The curator agent runs under the same provider as the source agent. If that provider cannot create a background agent (for example, terminal harness agents such as Claude Code, Codex CLI, OpenCode, or Hermes), the review is skipped by default. You can route those reviews to a specific provider by setting **Fallback provider** in the plugin's settings to any provider id enabled in Paseo (for example `codex` or `claude`). That provider then receives the turn excerpt described above.
