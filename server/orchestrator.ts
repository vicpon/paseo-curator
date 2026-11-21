import { createHash } from "node:crypto";
import {
  CuratorRunError,
  TurnReadError,
  type SourceAgent,
  type WholeTurnRead,
} from "./paseo-adapter";
import type { SkillSummary } from "./review-prompt";
import { buildReviewPrompt } from "./review-prompt";
import type { ReadSetEntry } from "./skill-manager";
import { MAX_SUBMISSIONS, REVIEW_TIMEOUT_MS, managerFeedback, submissionError, validateSubmission, type SubmissionHandler } from "./review-submission";
import type { QueueRecord, SkillOperation } from "./contracts";
import type { AuditInput } from "./store";
import type { ReviewSnapshot } from "./skill-manager";

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
  recordAuditIfClaimCurrent(id: string, claimAttempt: number, input: AuditInput): boolean;
  completeWithAudit(id: string, outcome: "applied" | "nothing_to_save", claimAttempt: number, input: AuditInput): boolean;
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
  runCurator(agent: SourceAgent, turnId: string, prompt: string, reviewId?: string, skillFiles?: Array<{ skillName: string; path: string; content: string }>, submit?: SubmissionHandler): Promise<{
    curatorAgentId: string;
    finalText: string;
  }>;
}

/** The guarded skill-manager surface the orchestrator consumes. */
interface SkillManagerLike {
  captureReviewSnapshot(): ReviewSnapshot;
  reviewSkillFiles(token: ReviewSnapshot): Array<{ skillName: string; path: string; content: string }>;
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
      reviewSnapshot?: ReviewSnapshot;
      authorized?: () => Promise<boolean>;
    },
  ): Promise<
    { outcome: "applied" | "rejected" | "rolled_back" | "rollback_failed" }
      & { rejectionReason?: string }
  >;
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
 *   turn, builds the review prompt, runs the curator with a structured submission tool,
 *   applies accepted operations through the skill manager, and transitions the
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
   * are bounded to identity + safe category, and an missing curator
   * submission is an explicit failure — none of them can carry transcript
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
      if (await this.reconcileRow(row)) return "failed";

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
        model: read.model,
      };

      // Build the review prompt from the exact turn and the current library.
      const reviewSnapshot = this.skillManager.captureReviewSnapshot();
      const skills = await this.listSkills();
      const prompt = buildReviewPrompt({
        sourceAgentId: row.sourceAgentId,
        turnId: row.turnId,
        entries: read.entries,
        skills,
      }).prompt;

      // All validation/apply happens while the reviewer is still running. Never
      // infer authority or success from final prose or model-supplied identity.
      let calls = 0;
      let lastFailure = "missing successful review submission";
      const reject = (message: string) => { lastFailure = message; return submissionError(message); };
      const deadline = Date.now() + REVIEW_TIMEOUT_MS;
      let accepted: { key: string; reply: Awaited<ReturnType<SubmissionHandler>> } | null = null;
      let terminal = false;
      let serial: Promise<unknown> = Promise.resolve();
      const submit: SubmissionHandler = (input, authorized) => {
        const pending = serial.then(async () => {
          if (Date.now() >= deadline) return reject("review time budget exhausted");
          if (!await authorized()) return reject("review authorization revoked or expired");
          const parsed = validateSubmission(input);
          const key = parsed.ok ? hashOperations(parsed.value.operations) + parsed.value.outcome : null;
          if (accepted) return key === accepted.key ? accepted.reply : reject("review already submitted; a different submission is not allowed");
          if (terminal || !this.store.isClaimCurrent(row.id, row.attempts)) return reject("queue claim is no longer current");
          if (++calls > MAX_SUBMISSIONS) return reject("submission repair budget exhausted");
          if (!parsed.ok) return reject(parsed.feedback);
          const proposal = parsed.value;
          const stillAuthorized = async () => Date.now() < deadline && await authorized();
          if (!await stillAuthorized() || !this.store.isClaimCurrent(row.id, row.attempts)) return reject("review authorization revoked or claim expired");
          if (proposal.outcome === "nothing_to_save") {
            const completed = this.store.completeWithAudit(row.id, "nothing_to_save", row.attempts, {
              ...context, outcome: "nothing_to_save", summary: "nothing to save", operationCount: 0,
              operationsHash: hashOperations([]), skillNames: [],
            });
            if (!completed) return reject("queue claim is no longer current");
          } else {
            const result = await this.skillManager.applyBatch(proposal.operations, [], {
              ...context, reviewSnapshot, authorized: stillAuthorized,
              claimIsCurrent: () => this.store.isClaimCurrent(row.id, row.attempts),
            });
            const applied = result.outcome === "applied";
            const audit: AuditInput = {
              ...context, outcome: applied ? "applied" : "rejected",
              summary: applied ? "batch applied" : "batch rejected", operationCount: proposal.operations.length,
              operationsHash: hashOperations(proposal.operations), skillNames: proposal.operations.map(op => op.skillName),
              ...(applied ? {} : { rejectionReason: `apply outcome: ${result.outcome}; ${managerFeedback(result.rejectionReason)}` }),
            };
            if (!applied) {
              this.store.recordAuditIfClaimCurrent(row.id, row.attempts, audit);
              if (result.outcome === "rollback_failed") {
                terminal = true;
                if (this.store.fail(row.id, "rollback failed; reconciliation required", row.attempts)) {
                  await this.notifyBestEffort({ outcome: "failed", sourceAgentId: row.sourceAgentId, turnId: row.turnId });
                }
                return reject("rollback failed; reconciliation required; stop this review");
              }
              return reject(managerFeedback(result.rejectionReason));
            }
            // The receipt already exists. Commit queue + audit before reporting
            // tool success, so a later provider error cannot erase applied work.
            if (!this.store.completeWithAudit(row.id, "applied", row.attempts, audit)) {
              terminal = true;
              return reject("claim expired after apply; durable receipt requires reconciliation");
            }
          }
          const reply = { text: `Review accepted: ${proposal.outcome}`, structuredContent: { accepted: true, outcome: proposal.outcome } };
          accepted = { key: key!, reply };
          if (proposal.outcome === "saved") {
            for (const op of proposal.operations) {
              try { this.store.recordSkillActivity(op.skillName, op.type === "create" ? "paseo-curator" : "unknown", op.type === "create" ? "create" : "patch"); } catch { /* audit is already durable */ }
            }
            await this.notifyBestEffort({ outcome: "applied", sourceAgentId: row.sourceAgentId, turnId: row.turnId,
              operationCount: proposal.operations.length, skillNames: [...new Set(proposal.operations.map(op => op.skillName))] });
          }
          return reply;
        });
        serial = pending.catch(() => { terminal = true; });
        return pending;
      };
      try {
        await this.adapter.runCurator(rereadAgent, row.turnId, prompt, `${row.id}:${row.attempts}`, this.skillManager.reviewSkillFiles(reviewSnapshot), submit);
        await serial;
      } catch (error) {
        await serial;
        if (!accepted) throw error;
      }
      if (!accepted) {
        if (this.store.isClaimCurrent(row.id, row.attempts) && await this.reconcileRow(row)) return "failed";
        return this.retryOrFailAndNotify(row, lastFailure);
      }
      return "failed";
    } catch (err) {
      // A callback may have committed a receipt before a database/provider
      // failure. Reconcile it now, even on the last retry, before failing.
      if (this.store.isClaimCurrent(row.id, row.attempts)) {
        try { if (await this.reconcileRow(row)) return "failed"; } catch { /* receipt remains for recovery */ }
      }
      // Bounded and content-free: only the identity and a safe category.
      // Never a transcript or model output fragment.
      return this.retryOrFailAndNotify(
        row,
        boundedFailure(row.sourceAgentId, row.turnId, err),
      );
    }
  }

  private async reconcileRow(row: QueueRecord): Promise<boolean> {
    const context = { queueId: row.id, sourceAgentId: row.sourceAgentId, turnId: row.turnId };
    const reconciliation = await this.skillManager.reconcileBatch(context);
    if (reconciliation.outcome === "applied") {
      const completed = this.store.completeWithAudit(row.id, "applied", row.attempts, {
        ...context,
        outcome: "applied",
        summary: "reconciled applied batch",
        operationCount: reconciliation.operationCount,
        operationsHash: reconciliation.operationsHash,
        skillNames: reconciliation.skillNames,
      });
      if (completed) {
        await this.notifyBestEffort({
          outcome: "applied",
          sourceAgentId: row.sourceAgentId,
          turnId: row.turnId,
          operationCount: reconciliation.operationCount,
          skillNames: reconciliation.skillNames,
        });
      }
      return true;
    }
    if (reconciliation.outcome === "reconciliation_required") {
      this.store.recordAuditIfClaimCurrent(row.id, row.attempts, {
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
      return true;
    }

    return false;
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.notify(notification),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
        ]);
      } finally { clearTimeout(timer); }
    } catch (err) {
      // Timeline visibility must never change the durable review outcome.
      // Surface only the error's class name (never its message, which may
      // carry untrusted content) so notification failures stay diagnosable.
      console.error(
        `[curator] timeline notify failed: ${err instanceof Error ? err.name : "unknown-error"}`,
      );
    }
  }
}

/**
 * Build a bounded, content-free failure string: the source identity plus a
 * safe category. For {@link CuratorRunError} and {@link TurnReadError} the
 * safe category is carried in the message itself (identity + a bounded
 * category such as `create-failed`, `timeline gap`, or a capped daemon
 * payload error — never transcript, prompt, or model output), so it is
 * preserved for diagnosis. Every other thrown value contributes only its
 * error class name; its message may echo untrusted content and is
 * intentionally dropped.
 */
function boundedFailure(sourceAgentId: string, turnId: string, err: unknown): string {
  const category =
    err instanceof CuratorRunError || err instanceof TurnReadError
      ? err.message
      : err instanceof Error && err.name !== ""
        ? err.name
        : "unexpected-error";
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
