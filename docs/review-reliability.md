# Review submission reliability

[Project README](../README.md) · [Routing contract](routing.md)

This change follows merged PR7 (`d41c415`). It fixes two observed failure mechanisms; it does not recover failed production reviews or establish that every provider succeeds.

## Production evidence and causes

Read-only production SQLite and authenticated Paseo SDK timeline inspection found:

- `q_mwr59st4_mctusu9m`: OMP/Sonnet reviewers submitted `operations` as the string `"[]"` on 11 retained failed calls across three attempts. The callback rejected the type but returned only `operations: invalid_type` plus generic instructions. No native array repair appeared in those retained calls.
- `q_mwqu5qza_utabllfi`: OMP/Qwen reviewers likewise submitted JSON-encoded arrays, including saved-operation arrays. Eight retained execution calls had string operations; one other failed call had no operations. One retained schema-description read was completed, not a successful submission. Repair budget exhaustion stayed a failure.
- `q_mwr6h7yk_w6cne5m6`: enqueue succeeded and one reviewer launched. Later attempts failed to find the source turn. The daemon logged source resume from persistence at `2026-11-22T01:49:01.484Z`; the final attempt began at `01:49:01.602Z`. Authenticated refetch returned 49 entries, all lacking daemon turn IDs. Paseo's history hydration intentionally does not invent daemon turn identity for provider history (`attachManagedTurnIdentity`, `fromHistory`). The exact reason the live session ceased residency is not established by retained logs. Raising retries cannot reconstruct a lost identity.

Sensitive arguments, generated content and transcripts remain only in private Hermes scratch evidence. Committed fixtures use harmless strings and structural shapes. No malformed outer argument wrapper was observed; no wrapper-unpacking behavior is added.

The permissive transport originally advertised `operations?: unknown` even though the tool description embedded the strict schema. The new transport exposes a native array alternative while still delivering malformed JSON primitive/string/object values to the counted callback. Strict submission validation remains authoritative: strings are rejected, never decoded into accepted proposals. Schema errors include safe field paths, exact operation field sets, a native-array no-op example and explicit same-run repair instructions, also in structured feedback. No final-answer JSON parsing exists. The four-submission and five-minute limits are unchanged. Feedback states how many submissions remain and stops advertising another repair once the fourth submission fails.

## Captured source turns and privacy

A successful completion-time read is bounded and, when encodable within storage limits, persisted in the **same transaction** as threshold-crossing enqueue/counter reset. Reviews prefer that exact `(sourceAgentId, turnId)` capture, including source provider/model/cwd, rather than fetching a potentially replaced provider timeline. Skill snapshots are still captured immediately before review and checked under the manager's existing locks at apply time.

Migration v4 adds a previously unused `captured_turns` table and a `queue.source_captured` content-free witness defaulting to false. It preserves old queue/audit outcomes and migrations. Existing rows receive no invented captures. Oversized payloads or unsupported capture metadata preserve cadence and enqueue without a capture/witness, using normal exact-turn reread/retries; capture serialization cannot stall reconciliation. Source/turn identity mismatch still fails before cadence or queue mutation. The witness is deliberately separate from `observed_turns`, whose historical migration backfilled queue identities and therefore cannot prove that a source read succeeded.

Storage limits and deletion:

- At most 100 captures, each at most 512,000 UTF-8 bytes. The newest 31 mapped entries are retained with at most 4,001 raw characters per entry; review still displays the newest 30 entries capped at 4,000 escaped characters. The extra entry/character and original entry count preserve omission/truncation signals. These are excerpts, not secret redaction.
- Captures expire after 24 hours. Lookup excludes expired captures without writing. Startup, new captured enqueue and the existing five-minute reconciliation timer attempt physical pruning; a transient writer lock can delay deletion until a later attempt. Offline files are pruned at next startup; expiry is not secure physical erasure.
- Terminal queue transitions delete the capture transactionally, including explicit failure, retry exhaustion and stale-running exhaustion. A stale claim cannot delete another attempt's capture. Count eviction removes the oldest capture content; its queue identity/witness remains.
- SQLite main/WAL/SHM files are restricted to owner read/write before capture use. Startup fails closed if those permissions cannot be applied; operators must correct file ownership or filesystem permission support rather than use weaker permissions. Logical deletion does not erase old WAL pages, free pages, backups, provider history or generated skill content. This is not encrypted storage.
- To forget a source's queued excerpts, stop Curator and delete `captured_turns` rows whose `queue_id` belongs to that source in `queue`, then restart when intended. The store's `deleteCapturedTurns(sourceAgentId)` performs that deletion. This is an operator action, not an automatic response to deleting a Paseo agent. Delete backups separately according to your retention policy. Removing a capture does not itself cancel a queue row: a retained exact source turn can still be fetched for review. Cancel/terminalize pending work as part of an operator privacy removal if review itself must stop.

Legacy/expired/evicted captures fall back only to the requested exact turn. Exhausted history with a durable successful-capture witness fails as `source-history-unavailable` without futile retries. Legacy rows without that proof retain their retry budget, as do genuine fetch/reset/gap races. No neighboring turn or fabricated source is used. A damaged capture fails closed and can exhaust the normal retries; no automatic corruption recovery or substitute history is inferred.

## Validation and UAT

Regression RED/GREEN transcripts and private live evidence are under Hermes scratch `curator-reliability-evidence`, outside the repository. Automated tests exercise the pinned real Paseo hook, tool serialization, JSON-schema-to-Zod MCP bridge and callback; live provider inference is tested separately with a controlled scratch fixture.

1. Run `npm ci --ignore-scripts`, `npm test`, `npm run typecheck`, and `npm pack --dry-run --ignore-scripts`. CI runs those checks on Node 22 and 24.
2. In a scratch skill root and SQLite DB only, queue a real completed source turn. Submit string operations, then a valid native array in the same reviewer run. Expect safe schema feedback, one accepted durable queue/audit outcome and one guarded patch. Repeat the same accepted call: expect the same success, with no second apply/audit.
3. Capture a source at enqueue, reopen the scratch DB and replace the live timeline. Expect the captured exact source/provider/turn to be reviewed without a second history fetch. Expire/delete the capture and exhaust that exact identity: expect a failed row, never a substituted turn or implicit no-op. A transient reset remains retryable.
4. Verify terminal capture deletion, 24-hour expiry, 100-capture cap, original-capture preservation on duplicate completion, identity mismatch refusal, stale attempt fencing and owner-only DB permissions. Test a held SQLite writer lock during the periodic prune: the plugin must continue rather than throw from its timer.

Production before/after comparison must use deployment windows, not old failures predating structured submission. At `2026-11-22T01:57:26Z`, rows created since structured reload `2026-11-21T19:40:22.206Z` totaled 15: **3 applied, 9 explicit no-ops, 3 failed** (one schema, one repair-budget, one missing-history). This change is not deployed, so there is no production after window. Failed production rows are not replayed.

Live results and final verification counts belong in the PR with their exact tested revision. Provider sessions retain normal permissions; instructions to avoid native writes are not confinement. Controlled live successes do not prove all production/provider behavior or eviction scheduling. No UI change is part of this fix.
