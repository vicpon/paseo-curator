import { DatabaseSync } from "node:sqlite";
import { AuditRecordSchema, QueueRecordSchema, type AuditRecord, type QueueRecord, type QueueStatus } from "./contracts";
import type { SkillLifecycleState, SkillTelemetry } from "./maintenance";

/**
 * Durable SQLite-backed store for the curator review queue.
 *
 * The store owns:
 *  - the per-agent accumulated tool-iteration counter,
 *  - the review queue (keyed by sourceAgentId + turnId),
 *  - the lifecycle state machine (pending -> running -> applied|nothing_to_save|failed),
 *  - and the single reset rule for the counter.
 *
 * Every mutation that touches more than one row runs in an explicit
 * BEGIN/COMMIT/ROLLBACK transaction so the invariants (unique enqueue,
 * threshold crossing, state transition) are atomic and idempotent.
 *
 * Uses Node's built-in `node:sqlite` (no native third-party dependency).
 * `DatabaseSync` has no `transaction()` helper, so we drive the transaction
 * verbs manually in {@link CuratorStore.tx}.
 */

/** Default staleness window: 5 minutes. A running row older than this is recovered. */
export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

/** Effective configuration for the store. */
export interface StoreConfig {
  reviewThreshold: number;
  maxRetries: number;
  /** Returns the current time. Inject for deterministic tests. */
  now: () => Date;
  /** A running row whose `started_at` is older than this is considered stale. */
  staleAfterMs: number;
}

export interface StaleRecoveryResult {
  recoveredIds: string[];
  failed: Array<{ sourceAgentId: string; turnId: string }>;
}

/**
 * An internal row shape as stored in SQLite (before schema validation).
 */
interface QueueRow {
  id: string;
  source_agent_id: string;
  turn_id: string;
  status: QueueStatus;
  created_at: string;
  updated_at: string;
  attempts: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

/** An internal counter row. */
interface CounterRow {
  source_agent_id: string;
  accumulated_iterations: number;
}

export type AuditInput = Omit<AuditRecord, "id" | "timestamp">;

/**
 * Durable curator queue. Accepts an explicit database path (including
 * `:memory:`) so tests are isolated.
 */
export class CuratorStore {
  private db: DatabaseSync;
  private readonly reviewThreshold: number;
  private readonly maxRetries: number;
  private readonly now: () => Date;
  private readonly staleAfterMs: number;

  constructor(dbPath: string, config?: Partial<StoreConfig>) {
    this.db = new DatabaseSync(dbPath);
    this.reviewThreshold = config?.reviewThreshold ?? 10;
    this.maxRetries = config?.maxRetries ?? 3;
    this.now = config?.now ?? (() => new Date());
    this.staleAfterMs = config?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.tx(() => this.migrate());
  }

  /** Close the underlying database. */
  close(): void {
    this.db.close();
  }

  /**
   * Run `fn` inside an explicit SQLite transaction.
   *
   * If `fn` throws, the transaction is rolled back and the error re-thrown,
   * leaving no partial write. `BEGIN IMMEDIATE` is used so that a writer
   * transaction cannot be interleaved by another connection mid-transaction.
   */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // The transaction may already be rolled back; ignore.
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Migrations
  // ---------------------------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue (
        id            TEXT PRIMARY KEY,
        source_agent_id TEXT NOT NULL,
        turn_id       TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('pending','running','applied','nothing_to_save','failed')),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        started_at    TEXT,
        completed_at  TEXT,
        error         TEXT,
        UNIQUE (source_agent_id, turn_id)
      );

      CREATE TABLE IF NOT EXISTS agent_counters (
        source_agent_id TEXT PRIMARY KEY,
        accumulated_iterations INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS observed_turns (
        source_agent_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (source_agent_id, turn_id)
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_telemetry (
        skill_name TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active','stale','archived')),
        last_activity_at TEXT NOT NULL,
        view_count INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        patch_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id TEXT NOT NULL,
        source_agent_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('applied','rejected')),
        summary TEXT NOT NULL,
        operation_count INTEGER NOT NULL,
        operations_hash TEXT NOT NULL,
        skill_names_json TEXT NOT NULL,
        rejection_reason TEXT,
        created_at TEXT NOT NULL
      );
    `);

    const auditColumns = new Set(
      (this.db.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    const addAuditColumn = (name: string, definition: string): void => {
      if (!auditColumns.has(name)) this.db.exec(`ALTER TABLE audit_log ADD COLUMN ${name} ${definition}`);
    };
    addAuditColumn("source_agent_id", "TEXT NOT NULL DEFAULT 'legacy'");
    addAuditColumn("turn_id", "TEXT NOT NULL DEFAULT 'legacy'");
    addAuditColumn("summary", "TEXT NOT NULL DEFAULT 'legacy audit record'");
    addAuditColumn("operation_count", "INTEGER NOT NULL DEFAULT 0");
    addAuditColumn("operations_hash", `TEXT NOT NULL DEFAULT '${"0".repeat(64)}'`);
    addAuditColumn("rejection_reason", "TEXT");

    if (!this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get()) {
      this.db.exec(`
        CREATE TABLE queue_v2 (
          id TEXT PRIMARY KEY, source_agent_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','running','applied','nothing_to_save','failed')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, started_at TEXT, completed_at TEXT, error TEXT,
          UNIQUE (source_agent_id, turn_id)
        );
        INSERT INTO queue_v2
          SELECT id, source_agent_id, turn_id, status, created_at, updated_at,
                 attempts, started_at, completed_at, error FROM queue ORDER BY rowid;
        DROP TABLE queue;
        ALTER TABLE queue_v2 RENAME TO queue;
        CREATE TABLE audit_log_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          queue_id TEXT NOT NULL,
          source_agent_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('applied','rejected','nothing_to_save')),
          summary TEXT NOT NULL,
          operation_count INTEGER NOT NULL,
          operations_hash TEXT NOT NULL,
          skill_names_json TEXT NOT NULL,
          rejection_reason TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO audit_log_v2
          SELECT MIN(id), queue_id, source_agent_id, turn_id,
                 CASE WHEN outcome IN ('applied','nothing_to_save') THEN outcome ELSE 'rejected' END,
                 summary, operation_count, operations_hash, skill_names_json,
                 CASE WHEN outcome IN ('applied','nothing_to_save') THEN NULL
                      ELSE COALESCE(rejection_reason, 'legacy audit outcome') END,
                 created_at
          FROM audit_log
          GROUP BY queue_id, CASE WHEN outcome IN ('applied','nothing_to_save') THEN outcome ELSE 'rejected' END;
        DROP TABLE audit_log;
        ALTER TABLE audit_log_v2 RENAME TO audit_log;
        CREATE UNIQUE INDEX audit_log_terminal_outcome ON audit_log(queue_id, outcome);
        INSERT INTO schema_migrations (version, applied_at) VALUES (2, '${new Date().toISOString()}');
      `);
    }
    this.db.exec(`
      INSERT OR IGNORE INTO observed_turns (source_agent_id, turn_id, observed_at)
        SELECT source_agent_id, turn_id, updated_at FROM queue;
    `);

    this.db
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(1, new Date().toISOString());
  }

  getReconciliationCursor(): string | null {
    const row = this.db.prepare("SELECT value FROM plugin_state WHERE key = 'reconciliation_cursor'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setReconciliationCursor(cursor: string): void {
    this.db.prepare(
      `INSERT INTO plugin_state (key, value, updated_at) VALUES ('reconciliation_cursor', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(cursor, this.now().toISOString());
  }

  recordSkillActivity(
    skillName: string,
    createdBy: string,
    activity: "create" | "patch" | "view" | "use",
  ): void {
    const now = this.now().toISOString();
    const patch = activity === "patch" ? 1 : 0;
    const view = activity === "view" ? 1 : 0;
    const use = activity === "use" ? 1 : 0;
    this.db.prepare(
      `INSERT INTO skill_telemetry
         (skill_name, created_by, state, last_activity_at, view_count, use_count, patch_count)
       VALUES (?, ?, 'active', ?, ?, ?, ?)
       ON CONFLICT(skill_name) DO UPDATE SET
         state = 'active', last_activity_at = excluded.last_activity_at,
         view_count = view_count + excluded.view_count,
         use_count = use_count + excluded.use_count,
         patch_count = patch_count + excluded.patch_count`,
    ).run(skillName, createdBy, now, view, use, patch);
  }

  listSkillTelemetry(): SkillTelemetry[] {
    const rows = this.db.prepare(
      `SELECT skill_name, created_by, state, last_activity_at,
              view_count, use_count, patch_count
         FROM skill_telemetry ORDER BY skill_name ASC`,
    ).all() as Array<{
      skill_name: string; created_by: string; state: SkillLifecycleState;
      last_activity_at: string; view_count: number; use_count: number; patch_count: number;
    }>;
    return rows.map((row) => ({
      skillName: row.skill_name,
      createdBy: row.created_by,
      state: row.state,
      lastActivityAt: row.last_activity_at,
      viewCount: row.view_count,
      useCount: row.use_count,
      patchCount: row.patch_count,
    }));
  }

  setSkillState(skillName: string, state: SkillLifecycleState): void {
    this.db.prepare("UPDATE skill_telemetry SET state = ? WHERE skill_name = ?")
      .run(state, skillName);
  }

  recordAudit(input: AuditInput): void {
    const timestamp = this.now().toISOString();
    const record = AuditRecordSchema.parse({
      ...input,
      id: `${input.queueId}:${input.outcome}`,
      timestamp,
      skillNames: [...new Set(input.skillNames)].sort(),
    });
    this.db.prepare(
      `INSERT INTO audit_log
       (queue_id, source_agent_id, turn_id, outcome, summary, operation_count,
        operations_hash, skill_names_json, rejection_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(queue_id, outcome) DO NOTHING`,
    ).run(
      record.queueId, record.sourceAgentId, record.turnId, record.outcome,
      record.summary, record.operationCount, record.operationsHash,
      JSON.stringify(record.skillNames), record.rejectionReason ?? null, record.timestamp,
    );
  }

  /** Record an attempt failure only while that attempt still owns the row. */
  recordAuditIfClaimCurrent(id: string, claimAttempt: number, input: AuditInput): boolean {
    return this.tx(() => {
      if (input.queueId !== id || !this.isClaimCurrent(id, claimAttempt)) return false;
      this.recordAudit(input);
      return true;
    });
  }

  listAudit(): AuditRecord[] {
    const rows = this.db.prepare(
      `SELECT id, queue_id, source_agent_id, turn_id, outcome, summary,
              operation_count, operations_hash, skill_names_json,
              rejection_reason, created_at FROM audit_log ORDER BY id ASC`,
    ).all() as Array<{
      id: number; queue_id: string; source_agent_id: string; turn_id: string;
      outcome: AuditRecord["outcome"]; summary: string; operation_count: number;
      operations_hash: string; skill_names_json: string;
      rejection_reason: string | null; created_at: string;
    }>;
    return rows.map((row) => AuditRecordSchema.parse({
      id: String(row.id),
      queueId: row.queue_id,
      sourceAgentId: row.source_agent_id,
      turnId: row.turn_id,
      outcome: row.outcome,
      summary: row.summary,
      operationCount: row.operation_count,
      operationsHash: row.operations_hash,
      skillNames: JSON.parse(row.skill_names_json) as string[],
      rejectionReason: row.rejection_reason ?? undefined,
      timestamp: row.created_at,
    }));
  }

  // ---------------------------------------------------------------------------
  // Counter / cadence
  // ---------------------------------------------------------------------------

  /** Read the accumulated counter for an agent (0 if absent). */
  getCounter(sourceAgentId: string): number {
    const row = this.db
      .prepare("SELECT accumulated_iterations FROM agent_counters WHERE source_agent_id = ?")
      .get(sourceAgentId) as CounterRow | undefined;
    return row?.accumulated_iterations ?? 0;
  }

  hasObservedTurn(sourceAgentId: string, turnId: string): boolean {
    return this.db
      .prepare("SELECT 1 FROM observed_turns WHERE source_agent_id = ? AND turn_id = ?")
      .get(sourceAgentId, turnId) !== undefined;
  }

  /**
   * Record `iterations` for a completed source turn and return whether a
   * review was enqueued as a result.
   *
   * The accumulated counter is reset to 0 only on a fresh durable enqueue.
   * Concretely:
   *  - a known duplicate returns true without mutating the counter, preserving
   *    cadence accumulated by newer turns;
   *  - a fresh crossing (no row yet, total >= threshold) creates the row and
   *    resets the counter to 0, returning true;
   *  - a non-duplicate below the threshold accumulates and returns false.
   *
   * @param sourceAgentId the source agent that produced the turn
   * @param iterations    tool iterations the turn performed (>= 0)
   * @param turnId        defaults to `turn-1` for test convenience; callers in
   *                      production pass the real turn id.
   * @returns true when a queue row is durably present for the turn afterwards
   *          (a fresh row was created, or a duplicate event for an already
   *          queued turn was absorbed). A double-fired hook event for the same
   *          turn therefore always observes a durably-present row.
   */
  recordIteration(sourceAgentId: string, iterations: number, turnId = "turn-1"): boolean {
    return this.tx(() => {
      const exists = this.db
        .prepare("SELECT id FROM queue WHERE source_agent_id = ? AND turn_id = ?")
        .get(sourceAgentId, turnId);

      // Every completed turn is deduplicated durably, including turns that do
      // not cross the review threshold and therefore have no queue row.
      if (this.hasObservedTurn(sourceAgentId, turnId)) {
        return exists !== undefined;
      }
      this.db.prepare(
        "INSERT INTO observed_turns (source_agent_id, turn_id, observed_at) VALUES (?, ?, ?)",
      ).run(sourceAgentId, turnId, this.now().toISOString());

      const current = this.getCounter(sourceAgentId);
      const next = current + iterations;

      if (next >= this.reviewThreshold) {
        this.createQueueRow(sourceAgentId, turnId);
        this.setCounter(sourceAgentId, 0);
        return true;
      }

      // Threshold not crossed and no row for the turn yet: accumulate and
      // report that no review was enqueued.
      this.setCounter(sourceAgentId, next);
      return false;
    });
  }

  /** Set the accumulated counter for an agent (upsert). */
  private setCounter(sourceAgentId: string, value: number): void {
    this.db
      .prepare(
        `INSERT INTO agent_counters (source_agent_id, accumulated_iterations)
         VALUES (?, ?)
         ON CONFLICT (source_agent_id) DO UPDATE SET accumulated_iterations = excluded.accumulated_iterations`,
      )
      .run(sourceAgentId, value);
  }

  /** Create a pending queue row. */
  private createQueueRow(sourceAgentId: string, turnId: string): void {
    const id = randomId();
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO queue
           (id, source_agent_id, turn_id, status, created_at, updated_at, attempts, started_at, completed_at, error)
         VALUES (?, ?, ?, 'pending', ?, ?, 0, NULL, NULL, NULL)`,
      )
      .run(id, sourceAgentId, turnId, now, now);
  }

  /**
   * Explicitly enqueue a review for an agent+turn. Returns the row if one was
   * created or already exists; never throws on a duplicate (idempotent).
   */
  enqueue(sourceAgentId: string, turnId: string): QueueRecord | null {
    return this.tx(() => {
      const existing = this.db
        .prepare("SELECT * FROM queue WHERE source_agent_id = ? AND turn_id = ?")
        .get(sourceAgentId, turnId) as unknown as QueueRow | undefined;
      if (existing) return this.rowToRecord(existing);
      this.createQueueRow(sourceAgentId, turnId);
      const fresh = this.db
        .prepare("SELECT * FROM queue WHERE source_agent_id = ? AND turn_id = ?")
        .get(sourceAgentId, turnId) as unknown as QueueRow;
      return this.rowToRecord(fresh);
    });
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  /**
   * Claim the next pending review (oldest first), transitioning it to running.
   * Increments `attempts` and stamps `startedAt`. Returns null if there is no
   * pending work.
   */
  claimNext(): QueueRecord | null {
    return this.tx(() => {
      const row = this.db
        .prepare(
          // `rowid` is the implicit monotonic insertion sequence; it breaks
          // ties between rows created in the same millisecond so FIFO is
          // deterministic even when created_at collides.
          `SELECT * FROM queue WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        )
        .get() as unknown as QueueRow | undefined;
      if (!row) return null;
      return this.transitionToRunning(row.id);
    });
  }

  /** Claim a specific pending row by id. Returns null if it is not pending. */
  claim(id: string): QueueRecord | null {
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM queue WHERE id = ?").get(id) as unknown as QueueRow | undefined;
      if (!row) return null;
      if (row.status !== "pending") return null;
      return this.transitionToRunning(row.id);
    });
  }

  /** True only while this exact attempt generation still owns the running row. */
  isClaimCurrent(id: string, claimAttempt: number): boolean {
    const row = this.db
      .prepare("SELECT 1 AS owned FROM queue WHERE id = ? AND status = 'running' AND attempts = ?")
      .get(id, claimAttempt) as { owned: number } | undefined;
    return row?.owned === 1;
  }

  /**
   * Transition a running row to a terminal state (`applied` or
   * `nothing_to_save`). Idempotent: a row that is not `running` is left alone.
   */
  complete(id: string, outcome: "applied" | "nothing_to_save", claimAttempt: number): boolean {
    return this.tx(() => this.completeClaim(id, outcome, claimAttempt));
  }

  /** Commit a terminal outcome and its audit together, fenced by the claim. */
  completeWithAudit(id: string, outcome: "applied" | "nothing_to_save", claimAttempt: number, audit: AuditInput): boolean {
    if (audit.queueId !== id || audit.outcome !== outcome) throw new Error("audit does not match completion");
    return this.tx(() => {
      if (!this.completeClaim(id, outcome, claimAttempt)) return false;
      this.recordAudit(audit);
      return true;
    });
  }

  private completeClaim(id: string, outcome: "applied" | "nothing_to_save", claimAttempt: number): boolean {
    const now = this.now().toISOString();
    const result = this.db
      .prepare(
        `UPDATE queue
           SET status = ?, updated_at = ?, completed_at = ?, error = NULL
         WHERE id = ? AND status = 'running' AND attempts = ?`,
      )
      .run(outcome, now, now, id, claimAttempt);
    return result.changes === 1;
  }

  /**
   * Transition a running row to a terminal `failed` state with an error message.
   * Idempotent: a row that is not `running` is left alone.
   */
  fail(id: string, error: string, claimAttempt: number): boolean {
    return this.tx(() => {
      const now = this.now().toISOString();
      const result = this.db
        .prepare(
          `UPDATE queue
             SET status = 'failed', updated_at = ?, completed_at = ?, error = ?
           WHERE id = ? AND status = 'running' AND attempts = ?`,
        )
        .run(now, now, error, id, claimAttempt);
      return result.changes === 1;
    });
  }

  /**
   * Terminalize a failed review attempt with bounded retry: within the retry
   * budget the row is re-queued (`pending`) so the drain can claim it again
   * in the same pass; at or beyond the budget it is marked terminal `failed`
   * with `safeError` (a bounded, content-free string — never raw output,
   * transcript, or a thrown message) and `completedAt` stamped.
   *
   * The decision and write are transactional, so the attempt count is
   * consistent with the state transition. Rows already terminal
   * (`applied`, `nothing_to_save`, `failed`) — or `pending` — are never
   * touched (never re-queued, never failed) and are reported `"unchanged"`.
   *
   * `attempts` (set by the claim) is preserved on the re-queue path so the
   * retry budget is tracked across retries.
   *
   * @param id        the queue row id
   * @param safeError bounded, content-free failure reason for the terminal
   *                  `failed` state
   * @returns the row's status after the operation: `"pending"` when the row
   *          was re-queued for retry, `"failed"` when this call terminalizes
   *          it, and `"unchanged"` when another transition already won.
   */
  retryOrFail(
    id: string,
    safeError: string,
    claimAttempt: number,
  ): "pending" | "failed" | "stale" | "unchanged" {
    return this.tx(() => {
      const row = this.db
        .prepare("SELECT status, attempts FROM queue WHERE id = ?")
        .get(id) as unknown as Pick<QueueRow, "status" | "attempts"> | undefined;
      if (row === undefined || row.status !== "running") {
        // Terminal rows (applied, nothing_to_save, failed) and rows that are
        // never running (pending) remain unchanged. The contract reports
        return "unchanged";
      }
      if (row.attempts !== claimAttempt) {
        return "stale";
      }
      const now = this.now().toISOString();
      if (row.attempts < this.maxRetries) {
        this.db
          .prepare(
            `UPDATE queue
               SET status = 'pending', updated_at = ?, started_at = NULL, completed_at = NULL, error = NULL
             WHERE id = ? AND status = 'running' AND attempts = ?`,
          )
          .run(now, id, claimAttempt);
        return "pending";
      }
      this.db
        .prepare(
          `UPDATE queue
             SET status = 'failed', updated_at = ?, completed_at = ?, error = ?
           WHERE id = ? AND status = 'running' AND attempts = ?`,
        )
        .run(now, now, safeError, id, claimAttempt);
      return "failed";
    });
  }

  /**
   * Recover stale running rows.
   *
   * A "stale running" row is one that was left `running` (daemon restart,
   * crash, or interrupted curator) whose `started_at` timestamp is older than
   * `staleAfterMs` relative to the current time. For each such row:
   *   - if `attempts < maxRetries`, it is returned to `pending` so a fresh
   *     claim can retry it (a new claim increments `attempts`);
   *   - if `attempts >= maxRetries`, it is marked terminal `failed` with an
   *     error, so the retry budget is enforced and it is never re-queued.
   *
   * `applied` and `nothing_to_save` rows are never touched.
   *
   * Staleness is determined entirely from the `started_at` column and the
   * injected clock — no external flag is needed. This means recovery works
   * after a process restart without any test-only call.
   *
   * @returns rows requeued and rows newly terminal-failed by this recovery pass.
   */
  recoverStaleRunning(): StaleRecoveryResult {
    return this.tx(() => {
      // A row is stale if started_at is not null and is <= the cutoff
      // (an ISO-8601 string comparison works because all timestamps share the same format).
      const cutoff = new Date(this.now().getTime() - this.staleAfterMs).toISOString();
      const stale = this.db
        .prepare(
          `SELECT * FROM queue WHERE status = 'running' AND started_at IS NOT NULL AND started_at <= ?`,
        )
        .all(cutoff) as unknown as QueueRow[];
      const recovered: string[] = [];
      const failed: StaleRecoveryResult["failed"] = [];
      const now = this.now().toISOString();
      for (const row of stale) {
        if (row.attempts < this.maxRetries) {
          this.db
            .prepare(
              `UPDATE queue
                 SET status = 'pending', updated_at = ?, started_at = NULL
               WHERE id = ?`,
            )
            .run(now, row.id);
          recovered.push(row.id);
        } else {
          this.db
            .prepare(
              `UPDATE queue
                 SET status = 'failed', updated_at = ?, completed_at = ?, error = ?
               WHERE id = ?`,
            )
            .run(now, now, "exceeded maxRetries", row.id);
          failed.push({ sourceAgentId: row.source_agent_id, turnId: row.turn_id });
        }
      }
      return { recoveredIds: recovered, failed };
    });
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Fetch a queue row by (sourceAgentId, turnId), or null. */
  get(sourceAgentId: string, turnId: string): QueueRecord | null {
    const row = this.db
      .prepare("SELECT * FROM queue WHERE source_agent_id = ? AND turn_id = ?")
      .get(sourceAgentId, turnId) as unknown as QueueRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /** List all queue rows. */
  listAll(): QueueRecord[] {
    const rows = this.db.prepare("SELECT * FROM queue").all() as unknown as QueueRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private transitionToRunning(id: string): QueueRecord | null {
    const now = this.now().toISOString();
    const res = this.db
      .prepare(
        `UPDATE queue
           SET status = 'running', updated_at = ?, started_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, now, id);
    if (res.changes === 0) return null;
    const row = this.db.prepare("SELECT * FROM queue WHERE id = ?").get(id) as unknown as QueueRow;
    return this.rowToRecord(row);
  }

  private rowToRecord(row: QueueRow): QueueRecord {
    const parsed: Record<string, unknown> = {
      id: row.id,
      sourceAgentId: row.source_agent_id,
      turnId: row.turn_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      attempts: row.attempts,
    };
    if (row.started_at !== null) parsed.startedAt = row.started_at;
    if (row.completed_at !== null) parsed.completedAt = row.completed_at;
    if (row.error !== null) parsed.error = row.error;
    return QueueRecordSchema.parse(parsed) as QueueRecord;
  }
}

/** A small unique id generator. */
function randomId(): string {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
