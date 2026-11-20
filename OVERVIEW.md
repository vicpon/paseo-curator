Turns reusable, verified lessons from completed Paseo turns into automatic updates to shared skills.

After enough tool iterations, a background curator reviews a completed turn and proposes structured operations. The plugin validates these operations and applies accepted batches under the configured skill root, normally `~/.agents/skills/`. Existing user-owned skills can be patched and their support files can be removed. Automatic archival is limited to curator-created skills; protection from archival does not mean a skill is never changed.

Requires Paseo 0.16.0-beta.2 or later and Node.js 22 or later. Safe routes currently include Codex's native read-only sandbox and Claude's Read, Glob and Grep tool set with all MCP tools denied. Other installed providers remain visible with unavailable safety status. An ask or plan label is not proof of confinement.

## Data access and routing

The review prompt includes a bounded excerpt of one completed source turn and an index of the shared skill library. The excerpt can include user and assistant messages, reasoning, tool calls and output, file contents, credentials, secrets, and personal information already present in that turn. Bounding limits size, not sensitivity. There is no guarantee that credentials or file contents are excluded.

The background agent runs in the source workspace. Read tools can access skills and workspace files, and their results may also be sent to the provider. The receiving provider processes the prompt and tool results under its own data policy and the user's account settings. The plugin itself is trusted, unsandboxed daemon code with the daemon user's filesystem and network access.

When supported, reviews retain the exact source provider/model selection. In Settings → Plugins → Curator, **Fallback provider** discovers the host catalog and defaults to **None**. Selecting a supported, enabled provider explicitly authorizes transmission there if the source route cannot run. **Fallback model** can follow that provider's default or pin an available model. Refresh preserves selections without saving. Unavailable providers have disabled controls with reasons. There is no automatic cross-provider routing.

Settings are read again immediately before fallback creation; clearing, changing or invalidating consent prevents a pending fallback send. Submitted reviews cannot be recalled. Existing explicit Codex consent migrates unchanged, while invalid legacy settings become None.

If neither the source route nor an explicitly configured fallback has a supported policy, no review agent is created. These attempts use the existing retry budget and eventually show **Curator review failed**; they are not recorded as successful skips or `nothing_to_save`.

## Mutation safeguards and limits

The plugin captures skill versions before review and rejects operations if the touched skill changes before validation under its locks, including deletes. The model does not need to echo whole files or compute hashes. The plugin uses path checks, atomic writes, rollback, and an audit ledger. These locks coordinate plugin batches; they do not lock out arbitrary external editors.

The permission guard denies requests that reach Paseo. It alone does not confine provider-native tools. Confinement uses provider-native sandbox or tool restrictions; no live provider confinement test has been performed for this change. Read access and provider data handling remain part of the user's trust decision.
