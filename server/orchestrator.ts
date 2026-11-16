import { createHash } from "node:crypto";
import type { SourceAgent, WholeTurnRead } from "./paseo-adapter";
import type { SkillSummary } from "./review-prompt";
import { buildReviewPrompt } from "./review-prompt";
import { parseReviewResult, type ReadSetEntry } from "./review-parser";
import type { QueueRecord, SkillOperation } from "./contracts";
import type { AuditInput } from "./store";

// ---------------------------------------------------------------------------
// Structural dependency interfaces
// ---------------------------------------------------------------------------

/** The durable review-queue surface the orchestrator consumes. */
interface QueueStoreLike {
  getCounter(sourceAgentId: string): number;
  recordIteration(sourceAgentId: string, iterations: number, turnId: string): boolean;
  claimNext(): QueueRecord | null;
  isClaimCurrent(id: string, claimAttempt: number): boolean;
  recordSkillActivity(
    skillName: string,
    createdBy: string,
    activity: "create" | "patch" | "view" | "use",
  ): void;
  recordAudit(input: AuditInput): void;
  complete(id: string, outcome: "applied" | "nothing_to_save", claimAttempt: number): boolean;
  fail(id: string, safeError: string, claimAttempt: number): boolean;
  /**
   * Terminalize a failed review attempt: re-queues (`pending`) while the row's
   * attempts are below the retry budget, else marks it terminal `failed` with
   * the bounded, content-free `safeError`. Terminal rows are left unchanged
   * and reported `"unchanged"`.
   */
  retryOrFail(
    id: string,
    safeError: string,
    claimAttempt: number,
  ): "pending" | "failed" | "stale" | "unchanged";
  /**
   * Recover running rows whose `started_at` is older than the staleness
   * window (e.g. left behind by a crashed or restarted process): rows still
   * within the retry budget are returned to `pending`; rows at or beyond the
   * budget are marked terminal `failed`. Returns both kinds of transition.
   */
  recoverStaleRunning(): {
    recoveredIds: string[];
    failed: Array<{ sourceAgentId: string; turnId: string }>;
  };
}

/** The bounded timeline/curator adapter surface the orchestrator consumes. */
interface AdapterLike {
  readWholeTurn(agent: SourceAgent, turnId: string): Promise<WholeTurnRead>;
  runCurator(agent: SourceAgent, turnId: string, prompt: string): Promise<{
    curatorAgentId: string;
    finalText: string;
  }>;
}

/** The guarded skill-manager surface the orchestrator consumes. */
interface SkillManagerLike {
  reconcileBatch(
    context: { queueId: string; sourceAgentId: string; turnId: string },
  ): Promise<
    | { outcome: "none" }
    | { outcome: "applied"; operationsHash: string; operationCount: number; skillNames: string[] }
    | { outcome: "reconciliation_required"; operationsHash?: string; operationCount?: number; skillNames?: string[] }
  >;
  applyBatch(
    operations: SkillOperation[],
    readSet: ReadSetEntry[],
    context: {
      queueId: string;
      sourceAgentId: string;
      turnId: string;
      claimIsCurrent?: () => boolean;
    },
  ): Promise<{ outcome: "applied" | "rejected" | "rolled_back" | "rollback_failed" }>;
}

/** One summary of an existing skill, for the review prompt's skill index. */
export type { SkillSummary } from "./review-prompt";

/** A user-visible terminal curator outcome. No-op reviews are intentionally omitted. */
export type CuratorActivityNotification =
  | {
      outcome: "applied";
      sourceAgentId: string;
      turnId: string;
      operationCount: number;
      skillNames: string[];
    }
  | {
      outcome: "failed";
      sourceAgentId: string;
      turnId: string;
    };

/** Dependencies injected into the orchestrator. */
export interface CuratorOrchestratorOptions {
  /** Durable review-queue store (the `CuratorStore`). */
  store: QueueStoreLike;
  /** Bounded turn read + curator run adapter (the `PaseoAdapter`). */
  adapter: AdapterLike;
  /** Guarded skill manager (the `SkillManager`). */
  skillManager: SkillManagerLike;
  /** Lists the current skill library (summaries) for the review prompt. */
  listSkills: () => Promise<SkillSummary[]>;
  /** Detached task scheduler: the host invokes the returned task. */
  schedule: (task: () => Promise<void>) => void;
  /** Best-effort user-visible activity sink. No-op reviews are never sent. */
  notify?: (notification: CuratorActivityNotification) => Promise<void>;
}

/** The outcome reported by a completed-turn notification. */
export interface TurnHandledResult {
  /** Tool iterations recorded for the turn. */
  toolIterations: number;
  /** True when a queue row was created or is already present for the turn. */
  enqueued: boolean;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Lifecycle orchestration for the curator review pipeline.
 *
 * Responsibilities (one pass, one-at-a-time):
 *
 * - `handleCompletedTurn` (fast notification path): reads the completed turn
 *   exactly once, durably records its tool iterations, and — only after a
 *   queue row is durably present — schedules a detached drain. It never
 *   awaits curator work, so the host's turn-completion path stays fast.
 *
 * - `processPending` (the drain): single-flight. Concurrent callers share one
 *   drain; the drain claims the oldest pending row (FIFO), re-reads the exact
 *   turn, builds the review prompt, runs the curator, parses the strict
 *   result, applies operations through the skill manager, and transitions the
 *   row to a terminal state. It loops until no pending rows remain.
 *
 * - `shutdown`: prevents further scheduling and waits for the active drain.
 *
 * Duplicate scheduled drains (a hook double-fire) cannot duplicate curator
 * work: the queue key is unique on (sourceAgentId, turnId) and a row is only
 * curable while it is `running`.
 *
 * Errors are bounded and content-free: nothing from a transcript or model
 * output ever leaks into a persisted or surfaced error.
 */
export class CuratorOrchestrator {
  private readonly store: QueueStoreLike;
  private readonly adapter: AdapterLike;
  private readonly skillManager: SkillManagerLike;
  private readonly listSkills: () => Promise<SkillSummary[]>;
  private readonly schedule: (task: () => Promise<void>) => void;
  private readonly notify: (notification: CuratorActivityNotification) => Promise<void>;

  private active: Promise<void> | null = null;
  private readonly activeHandlers = new Set<Promise<TurnHandledResult>>();
  private shuttingDown = false;
  /** Turns for which a drain has already been scheduled (dedup key). */
  private scheduled = new Set<string>();

  constructor(options: CuratorOrchestratorOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.skillManager = options.skillManager;
    this.listSkills = options.listSkills;
    this.schedule = options.schedule;
    this.notify = options.notify ?? (async () => undefined);
  }

  /**
   * Handle a completed source turn (the `agent.turn.after` fast path).
   *
   * Reads the turn once for its tool iterations, durably records them
   * (creating a queue row and resetting the cadence counter only on a
   * threshold crossing), and schedules a detached drain when a queue row is
   * durably present. Never awaits curator work.
   */
  handleCompletedTurn(agent: SourceAgent, turnId: string): Promise<TurnHandledResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ toolIterations: 0, enqueued: false });
    }
    const handling = this.handleAcceptedTurn(agent, turnId);
    this.activeHandlers.add(handling);
    void handling.then(
      () => this.activeHandlers.delete(handling),
      () => this.activeHandlers.delete(handling),
    );
    return handling;
  }

  private async handleAcceptedTurn(agent: SourceAgent, turnId: string): Promise<TurnHandledResult> {
    // The turn is read exactly once, on this fast path. The read is bounded
    // and its failure is content-free (identity + safe category only).
    const read = await this.adapter.readWholeTurn(agent, turnId);
    for (const skillName of read.usedSkillNames) {
      this.store.recordSkillActivity(skillName, "unknown", "use");
    }

    // Durably record the turn's iterations; this is the only cadence
    // mutation. It creates a queue row only on a threshold crossing.
    const enqueued = this.store.recordIteration(agent.id, read.toolIterations, turnId);

    if (enqueued) {
      // `enqueued` means a queue row is durably present for the turn (fresh
      // crossing, or a duplicate event absorbed by the existing row). Both
      // require a drain. Scheduling is deduplicated per turn, so a
      // double-fired hook yields at most one scheduled task; the single-
      // flight drain and the unique queue key ensure the turn is curated
      // exactly once regardless.
      const key = turnKey(agent.id, turnId);
      if (!this.scheduled.has(key)) {
        this.scheduled.add(key);
        this.scheduleDrain();
      }
    }

    return { toolIterations: read.toolIterations, enqueued };
  }

  /**
   * Drain the pending queue, one row at a time, in FIFO order, until empty.
   *
   * Single-flight: concurrent callers share one drain and all await its
   * completion. Once shutdown has been requested, no further drains run
   * (already-queued drains complete).
   */
  processPending(): Promise<void> {
    if (this.active !== null) {
      return this.active;
    }
    if (this.shuttingDown) {
      return Promise.resolve();
    }
    this.active = this.drain().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  /**
   * Boot-time lifecycle recovery.
   *
   * Recovers running rows that outlived their staleness window (a crashed or
   * restarted process leaves rows `running`), then drains the queue — the
   * recovered rows land in `pending` and are picked up alongside any already
   * pending rows, even when no hook event fired.
   *
   * Single-flight: the drain runs through {@link processPending}, so a
   * concurrent hook-scheduled drain shares the same pass. Once shutdown has
   * been requested, nothing is recovered or drained.
   */
  async start(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    const recovery = this.store.recoverStaleRunning();
    for (const failed of recovery.failed) {
      await this.notifyBestEffort({
        outcome: "failed",
        sourceAgentId: failed.sourceAgentId,
        turnId: failed.turnId,
      });
    }
    await this.processPending();
  }

  /**
   * Stop the orchestrator: no further drains will be scheduled, and the call
   * resolves once any active drain completes.
   */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.scheduled.clear();
    const drain = this.active ?? Promise.resolve();
    const handlers = [...this.activeHandlers];
    return Promise.allSettled([drain, ...handlers]).then(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Schedule a detached drain, but never while shutting down. The task the
   * host runs is `processPending()`, which is itself single-flight, so a
   * double-scheduled task cannot duplicate curator work.
   */
  private scheduleDrain(): void {
    if (this.shuttingDown) {
      return;
    }
    this.schedule(() => this.processPending());
  }

  /**
   * Claim and process rows one at a time, FIFO, until the queue is empty.
   *
   * Every step is content-safe: a turn read failure and a curator failure
   * are bounded to identity + safe category, and an unparseable curator
   * result is a structured parse failure — none of them can carry transcript
   * or model output into the stored error.
   *
   * A failed attempt that is re-queued (`pending`) is claimed immediately in
   * the same drain, so a row that exhausts its retry budget reaches
   * `maxRetries` attempts within a single `processPending` call; the drain
   * only stops when `claimNext` reports the queue empty.
   */
  private async drain(): Promise<void> {
    for (;;) {
      const row = this.store.claimNext();
      if (row === null) {
        return;
      }
      await this.processRow(row);
      // Release the dedup slot once the turn's row is terminal, so the same
      // turn may legitimately schedule a future drain again (e.g. retry).
      this.scheduled.delete(turnKey(row.sourceAgentId, row.turnId));
    }
  }

  /**
   * Process a single claimed (now `running`) queue row to a terminal state.
   *
   * Every failure path terminalizes through `store.retryOrFail` with a
   * bounded, content-free reason (never raw output, transcript, or a thrown
   * message). Returns `"pending"` when the row was re-queued for retry,
   * otherwise `"failed"` — the caller uses this to decide whether the row
   * will be claimed again within the same drain.
   */
  private async processRow(row: QueueRecord): Promise<"pending" | "failed" | "stale" | "unchanged"> {
    const agent: SourceAgent = {
      id: row.sourceAgentId,
      provider: "",
      cwd: "",
    };

    try {
      const context = {
        queueId: row.id,
        sourceAgentId: row.sourceAgentId,
        turnId: row.turnId,
      };
      const reconciliation = await this.skillManager.reconcileBatch(context);
      if (reconciliation.outcome === "applied") {
        this.store.recordAudit({
          ...context,
          outcome: "applied",
          summary: "reconciled applied batch",
          operationCount: reconciliation.operationCount,
          operationsHash: reconciliation.operationsHash,
          skillNames: reconciliation.skillNames,
        });
        const completed = this.store.complete(row.id, "applied", row.attempts);
        if (completed) {
          await this.notifyBestEffort({
            outcome: "applied",
            sourceAgentId: row.sourceAgentId,
            turnId: row.turnId,
            operationCount: reconciliation.operationCount,
            skillNames: reconciliation.skillNames,
          });
        }
        return "failed";
      }
      if (reconciliation.outcome === "reconciliation_required") {
        this.store.recordAudit({
          ...context,
          outcome: "rejected",
          summary: "filesystem reconciliation required",
          operationCount: reconciliation.operationCount ?? 0,
          operationsHash: reconciliation.operationsHash ?? hashOperations([]),
          skillNames: reconciliation.skillNames ?? [],
          rejectionReason: "filesystem reconciliation required",
        });
        const failed = this.store.fail(row.id, "filesystem reconciliation required", row.attempts);
        if (failed) {
          await this.notifyBestEffort({
            outcome: "failed",
            sourceAgentId: row.sourceAgentId,
            turnId: row.turnId,
          });
        }
        return "failed";
      }

      // Re-read the exact turn (the claim does not carry a snapshot).
      const read = await this.adapter.readWholeTurn(agent, row.turnId);

      // The durable row stores only the source id and turn, so `agent` above
      // is a placeholder. Rebuild the source identity from the re-read: the
      // adapter recovered the authoritative provider/cwd from the timeline
      // payload's agent snapshot. The curator runs under that real identity.
      const rereadAgent: SourceAgent = {
        id: read.sourceAgentId,
        provider: read.provider,
        cwd: read.cwd,
      };

      // Build the review prompt from the exact turn and the current library.
      const skills = await this.listSkills();
      const prompt = buildReviewPrompt({
        sourceAgentId: row.sourceAgentId,
        turnId: row.turnId,
        entries: read.entries,
        skills,
      }).prompt;

      // Run the curator and parse its strict, content-validated result.
      const result = await this.adapter.runCurator(rereadAgent, row.turnId, prompt);
      const parsed = parseReviewResult(result.finalText);

      if (parsed === null) {
        // The parser records a structured, secret-safe reason; it never
        // echoes the model output.
        return this.retryOrFailAndNotify(row, "invalid curator output");
      }

      if (parsed.outcome === "nothing_to_save") {
        // A valid nothing verdict must carry no mutations; the schema does
        // not guarantee that, so verify before terminating without a batch.
        if (parsed.operations.length !== 0 || parsed.readSet.length !== 0) {
          return this.retryOrFailAndNotify(row, "invalid curator output");
        }
        this.store.recordAudit({
          ...context,
          outcome: "applied",
          summary: "nothing to save",
          operationCount: 0,
          operationsHash: hashOperations([]),
          skillNames: [],
        });
        this.store.complete(row.id, "nothing_to_save", row.attempts);
        return "failed";
      }

      // Apply the batch with the row's exact identity. Only an `applied`
      // outcome marks the review applied; every other outcome (rejected,
      // rolled back, rollback failed) is a failed review.
      const applyResult = await this.skillManager.applyBatch(
        parsed.operations,
        parsed.readSet,
        {
          ...context,
          claimIsCurrent: () => this.store.isClaimCurrent(row.id, row.attempts),
        },
      );
      const applied = applyResult.outcome === "applied";
      this.store.recordAudit({
        ...context,
        outcome: applied ? "applied" : "rejected",
        summary: applied ? "batch applied" : "batch rejected",
        operationCount: parsed.operations.length,
        operationsHash: hashOperations(parsed.operations),
        skillNames: parsed.operations.map((operation) => operation.skillName),
        ...(applied ? {} : { rejectionReason: `apply outcome: ${applyResult.outcome}` }),
      });

      if (applyResult.outcome === "applied") {
        for (const operation of parsed.operations) {
          const activity = operation.type === "create" ? "create" : "patch";
          const createdBy = operation.type === "create" ? "paseo-curator" : "unknown";
          this.store.recordSkillActivity(operation.skillName, createdBy, activity);
        }
        const completed = this.store.complete(row.id, "applied", row.attempts);
        if (completed) {
          await this.notifyBestEffort({
            outcome: "applied",
            sourceAgentId: row.sourceAgentId,
            turnId: row.turnId,
            operationCount: parsed.operations.length,
            skillNames: [...new Set(parsed.operations.map((operation) => operation.skillName))],
          });
        }
      } else if (applyResult.outcome === "rollback_failed") {
        const failed = this.store.fail(
          row.id,
          "rollback failed; reconciliation required",
          row.attempts,
        );
        if (failed) {
          await this.notifyBestEffort({
            outcome: "failed",
            sourceAgentId: row.sourceAgentId,
            turnId: row.turnId,
          });
        }
      } else {
        await this.retryOrFailAndNotify(row, "apply outcome not applied");
      }
      return "failed";
    } catch (err) {
      // Bounded and content-free: only the identity and a safe category.
      // Never a transcript or model output fragment.
      return this.retryOrFailAndNotify(
        row,
        boundedFailure(row.sourceAgentId, row.turnId, err),
      );
    }
  }

  private async retryOrFailAndNotify(
    row: QueueRecord,
    safeError: string,
  ): Promise<"pending" | "failed" | "stale" | "unchanged"> {
    const result = this.store.retryOrFail(row.id, safeError, row.attempts);
    if (result === "failed") {
      await this.notifyBestEffort({
        outcome: "failed",
        sourceAgentId: row.sourceAgentId,
        turnId: row.turnId,
      });
    }
    return result;
  }

  private async notifyBestEffort(notification: CuratorActivityNotification): Promise<void> {
    try {
      await this.notify(notification);
    } catch {
      // Timeline visibility must never change the durable review outcome.
    }
  }
}

/**
 * Build a bounded, content-free failure string: the source identity plus a
 * safe category. The thrown value's own message is intentionally NOT
 * included — it may echo transcript or model content.
 */
function boundedFailure(sourceAgentId: string, turnId: string, err: unknown): string {
  const category =
    err instanceof Error && err.name !== "" ? err.name : "unexpected-error";
  return `curator failed for agent "${sourceAgentId}" turn "${turnId}": ${category}`.slice(
    0,
    500,
  );
}

function hashOperations(operations: SkillOperation[]): string {
  return createHash("sha256").update(JSON.stringify(operations)).digest("hex");
}

/** A per-orchestrator dedup key for (agent, turn) scheduling. */
function turnKey(agentId: string, turnId: string): string {
  return `${agentId}:${turnId}`;
}
