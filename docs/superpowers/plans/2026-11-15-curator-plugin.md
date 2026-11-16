# Paseo Curator Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daemon-side Paseo plugin that automatically turns reusable lessons from completed agent work into guarded shared-skill updates.

**Architecture:** `agent.turn.after` captures eligible source turns into a durable SQLite queue. Provider-agnostic curator agents produce schema-validated skill operations; a local skill manager applies them atomically inside `~/.agents/skills/`, records provenance/audit data, and periodically stales or archives only curator-created skills.

**Tech Stack:** TypeScript, Paseo Plugin SDK `>=0.16.0-beta.2`, Node `node:sqlite`, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-curator-design.md`

## Global Constraints

- Server-only plugin; no first-version UI.
- Default skill root is `~/.agents/skills/` and every mutation must remain inside its canonical path.
- Automatic review cadence is 10 accumulated tool iterations.
- Curator agents inherit the source agent's provider route and are excluded from their own trigger.
- Curator output is untrusted and cannot directly write files.
- Existing targets require exact read-before-write evidence.
- Batches are atomic and capped at 20 operations.
- Automatic maintenance never deletes; archive is limited to `created_by: paseo-curator` skills.
- Preserve the Nous Research MIT notice for adapted Hermes methodology.

## Review Focus

- Duplicate and concurrent `agent.turn.after` events produce one queue row and one review.
- A symlink or `..` path cannot escape the skill root.
- A partial multi-skill write failure restores every touched skill.
- Curator completion events never enqueue another curator review.
- Plugin restart recovers pending/running work without repeating already-applied batches.

---

### Task 1: Scaffold and domain contracts

**Files:**
- Create: `paseo-plugin.json`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `LICENSE`
- Create: `NOTICE`
- Create: `src/contracts.ts`
- Create: `tests/contracts.test.ts`

**Interfaces:**
- Produces: Zod schemas and TypeScript types for `QueueRecord`, `ReviewResult`, `SkillOperation`, `SkillManifest`, `AuditRecord`, and `PluginConfig`.

- [ ] Write failing schema tests for valid operations, unknown keys, the 20-op limit, malformed names, unsupported support-file paths, and `nothing_to_save`.
- [ ] Run `npm test -- tests/contracts.test.ts` and verify failure because contracts are absent.
- [ ] Scaffold the Paseo plugin, replace the greeting sample, add Vitest, and implement only the contracts required by the tests.
- [ ] Run the focused test and `npm run typecheck`.
- [ ] Initialize Git if needed and commit as `feat: scaffold curator plugin contracts`.

### Task 2: Durable queue and cadence

**Files:**
- Create: `src/store.ts`
- Create: `src/eligibility.ts`
- Create: `tests/store.test.ts`
- Create: `tests/eligibility.test.ts`

**Interfaces:**
- Consumes: Task 1 queue/audit types.
- Produces: `CuratorStore`, `evaluateTurn()`, and durable transitions `pending → running → applied|nothing_to_save|failed`.

- [ ] Write failing tests for schema creation, unique `(sourceAgentId, turnId)`, 10-iteration accumulation, completed-only eligibility, retry recovery, and applied-row idempotency.
- [ ] Run the focused tests and verify expected failures.
- [ ] Implement SQLite migrations, transactions, queue methods, counters, attempts, and eligibility logic.
- [ ] Run focused tests, full tests, and typecheck.
- [ ] Commit as `feat: add durable curator queue`.

### Task 3: Guarded atomic skill manager

**Files:**
- Create: `src/skill-manager.ts`
- Create: `src/skill-files.ts`
- Create: `tests/skill-manager.test.ts`
- Create: `tests/fixtures.ts`

**Interfaces:**
- Consumes: Task 1 `SkillOperation` types.
- Produces: `SkillManager.applyBatch(operations, readSet, context)` and reversible archive support.

- [ ] Write failing tests for create, unique patch, support-file creation, exact read-before-write, traversal rejection, realpath/symlink rejection, frontmatter validation, provenance rules, and 20-op enforcement.
- [ ] Add a failing fault-injection test proving a later operation failure restores every earlier mutation.
- [ ] Run focused tests and verify failures.
- [ ] Implement canonical path checks, per-skill locks, preflight validation, snapshots, temp-file atomic rename, rollback, provenance, and audit hashes.
- [ ] Run focused tests, full tests, and typecheck.
- [ ] Commit as `feat: add guarded atomic skill manager`.

### Task 4: Hermes-style review prompt and parser

**Files:**
- Create: `src/review-prompt.ts`
- Create: `src/review-parser.ts`
- Create: `tests/review-prompt.test.ts`
- Create: `tests/review-parser.test.ts`

**Interfaces:**
- Consumes: Task 1 review schemas and a bounded Paseo timeline snapshot.
- Produces: `buildReviewPrompt()`, `buildSkillIndex()`, `parseReviewResult()`, and exact read-set extraction.

- [ ] Write failing tests for correction/fix/workflow signals, exclusions for unresolved failures/secrets/one-offs, class-level skill preference, transcript bounds, and JSON extraction from plain/fenced responses.
- [ ] Run focused tests and verify failures.
- [ ] Adapt the Hermes methodology under its MIT notice and implement deterministic prompt construction and strict parsing.
- [ ] Run focused tests, full tests, and typecheck.
- [ ] Commit as `feat: add hermes-style skill review`.

### Task 5: Paseo lifecycle orchestration

**Files:**
- Create: `index.server.ts`
- Create: `src/orchestrator.ts`
- Create: `src/paseo-adapter.ts`
- Create: `tests/orchestrator.test.ts`
- Create: `tests/plugin.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: registered `agent.turn.after` hook, exact-turn capture, provider-agnostic background-agent creation, curator-result handling, retries, and recursion exclusion.

- [ ] Write failing adapter tests for whole-turn timeline reads, source provider metadata, and provider-inheriting curator creation with `background: true`, labels, metadata, and source cwd.
- [ ] Write failing orchestration tests for enqueue, threshold crossing, duplicate events, curator exclusion, successful apply, `nothing_to_save`, malformed output, retry cap, and shutdown recovery.
- [ ] Run focused tests and verify failures.
- [ ] Implement the hook as a fast notification handler that durably enqueues before detached processing; do not block source-agent completion.
- [ ] Implement one-at-a-time queue processing and source/curator linkage.
- [ ] Run focused tests, full tests, and typecheck.
- [ ] Commit as `feat: wire paseo curator lifecycle`.

### Task 6: Reconciliation and maintenance

**Files:**
- Create: `src/reconciliation.ts`
- Create: `src/maintenance.ts`
- Create: `tests/reconciliation.test.ts`
- Create: `tests/maintenance.test.ts`

**Interfaces:**
- Consumes: store, Paseo adapter, and skill manager.
- Produces: startup/interval reconciliation and deterministic `active → stale → archived` transitions.

- [ ] Write failing tests for missed-hook recovery, cursor persistence, no replay of applied rows, overlapping timer exclusion, 14-day stale state, 30-day archive, and protection of non-curator skills.
- [ ] Run focused tests and verify failures.
- [ ] Implement bounded recent-timeline reconciliation, run claim, telemetry updates, recoverable archive, and cleanup on plugin stop.
- [ ] Run focused tests, full tests, and typecheck.
- [ ] Commit as `feat: add curator reconciliation and maintenance`.

### Task 7: Documentation, packaging, and end-to-end verification

**Files:**
- Create: `README.md`
- Create: `tests/e2e/plugin.e2e.test.ts`
- Modify: `package.json`
- Modify: `paseo-plugin.json`

**Interfaces:**
- Consumes: complete plugin.
- Produces: installable local plugin and evidence of a real Paseo lifecycle run.

- [ ] Write a failing end-to-end test around a temporary skill root and fake Paseo daemon boundary: source turn → threshold → curator result → atomic skill patch.
- [ ] Run it and verify the expected failure.
- [ ] Add installation/configuration, data-path, safety, recovery, and attribution documentation; complete packaging metadata.
- [ ] Run `npm test`, `npm run typecheck`, and `npm pack --dry-run`.
- [ ] Install locally with `paseo plugin install /absolute/path/to/curator`, reload it, and verify it appears enabled in `paseo plugin ls`.
- [ ] Exercise one controlled source turn using an isolated temporary skill root, then read back the created/patched skill and audit row.
- [ ] Commit as `docs: finish curator plugin`.

### Task 8: Independent review and remediation

**Files:**
- Modify: only files required by validated review findings.

**Interfaces:**
- Consumes: complete diff and approved design.
- Produces: reviewed, reverified plugin.

- [ ] Dispatch an independent reviewer with the spec, plan, and full diff; require Security, Correctness, Paseo API, and Test Coverage findings with file/line evidence.
- [ ] Reproduce every Critical or Important finding with a failing test.
- [ ] Fix validated findings using red-green-refactor.
- [ ] Re-run `npm test`, `npm run typecheck`, `npm pack --dry-run`, local plugin reload, and the controlled end-to-end scenario.
- [ ] Commit fixes as `fix: address curator plugin review`.
