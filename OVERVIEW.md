Turns reusable, verified lessons from completed Paseo turns into automatic updates to shared skills.

After enough tool iterations, a background curator reviews a completed turn and proposes structured operations. The plugin validates these operations and applies accepted batches under the configured skill root, normally `~/.agents/skills/`. Existing user-owned skills can be patched and their support files can be removed. Automatic archival is limited to curator-created skills; protection from archival does not mean a skill is never changed.

Requires Paseo 0.16.0-beta.2 or later and Node.js 22 or later. Safe routes currently include Codex's native read-only sandbox and Claude's Read, Glob and Grep tool set with all MCP tools denied. OpenCode denies all native and MCP tools and receives bounded skill text captured by the plugin. Only enabled host providers are listed; ready providers with unsupported safety policies show a review-blocked reason. An ask or plan label is not proof of confinement.

## Data access and routing

The review prompt includes a bounded excerpt of one completed source turn and an index of the shared skill library. The excerpt can include user and assistant messages, reasoning, tool calls and output, file contents, credentials, secrets, and personal information already present in that turn. Bounding limits size, not sensitivity. There is no guarantee that credentials or file contents are excluded.

OpenCode reviews also receive up to 120,000 serialized characters of captured skill-file text. Hidden paths and common binary indicators are omitted, which does not guarantee the absence of secrets. This extra bundle is not sent on Codex/Claude routes.

The background agent runs in the source workspace. Read tools can access skills and workspace files, and their results may also be sent to the provider. The receiving provider processes the prompt and tool results under its own data policy and the user's account settings. The plugin itself is trusted, unsandboxed daemon code with the daemon user's filesystem and network access.

When supported, reviews retain the exact source provider/model selection. In Settings → Plugins → Curator, **Review provider** offers supported providers from the host catalog and defaults to **None**. Selecting a supported, enabled provider explicitly authorizes transmission there if the source route cannot run. **Review model** can follow that provider's default or pin an available model. Refresh preserves selections without saving. Host-disabled providers are omitted from the selector. Saved inactive choices remain preserved and cannot silently switch to another provider. There is no automatic cross-provider routing.

Settings are read again immediately before fallback creation; clearing, changing or invalidating consent prevents a pending fallback send. Submitted reviews cannot be recalled. Existing explicit Codex consent migrates unchanged, while invalid legacy settings become None.

If neither the source route nor an explicitly configured fallback has a supported policy, no review agent is created. These attempts use the existing retry budget and eventually show **Curator review failed**; they are not recorded as successful skips or `nothing_to_save`.

## Mutation safeguards and limits

The plugin captures skill versions before review and rejects operations if the touched skill changes before validation under its locks, including deletes. The model does not need to echo whole files or compute hashes. The plugin uses path checks, atomic writes, rollback, and an audit ledger. These locks coordinate plugin batches; they do not lock out arbitrary external editors.

The permission guard denies requests that reach Paseo. It alone does not confine provider-native tools. Confinement uses provider-native sandbox or tool restrictions; live route and canary observations are recorded in the routing documentation, with their limits. Read access and provider data handling remain part of the user's trust decision.
