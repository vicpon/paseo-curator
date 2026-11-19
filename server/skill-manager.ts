import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillOperation } from "./contracts";
import {
  atomicCreate,
  atomicMoveDir,
  atomicWrite,
  countOccurrences,
  acquireSkillLocks,
  releaseSkillLocks,
  parseFrontmatter,
  resolveSkillPath,
  restoreSkill,
  sha256,
  snapshotSkill,
  validateFrontmatter,
  stampCuratorProvenance,
  validateFrontmatterPreserved,
  CURATOR_PROVENANCE,
  validateSkillName,
  verifyContained,
  type RestoreSkillFn,
  type SkillLock,
  type SkillSnapshot,
} from "./skill-files";

// ===========================================================================
// Read set
// ===========================================================================

/**
 * A read-set entry: the exact content the curator agent read for a given file
 * at review time. Used as read-before-write evidence.
 *
 * `hash` is the SHA-256 of `content` at the time the agent read it. The
 * manager re-validates this hash against the locked snapshot before applying
 * any write to that file.
 */
export interface ReadSetEntry {
  skillName: string;
  path: string;
  content: string;
  hash: string;
}

// ===========================================================================
// Fault injection (dependency injection, not a production method)
// ===========================================================================

/**
 * A fault-injection hook, called before each operation during the apply
 * phase. Tests inject a hook that throws to prove rollback. Production
 * callers never set this.
 */
export type FaultInjector = (
  operationIndex: number,
  operation: SkillOperation,
) => void;

// ===========================================================================
// Apply result
// ===========================================================================

/** The outcome of a single operation within a batch. */
export interface OperationOutcome {
  index: number;
  type: SkillOperation["type"];
  skillName: string;
  status: "applied" | "skipped" | "failed";
  error?: string;
}

/** The before/after hash of a file touched by a batch. */
export interface FileHashPair {
  before: string | null;
  after: string | null;
}

/**
 * The result of applying (or rejecting/rolling back) a batch.
 *
 * - `outcome: "applied"`: every operation succeeded; files are at their
 *   post-batch state; `fileHashes` carries before/after hashes.
 * - `outcome: "rejected"`: preflight validation failed before any mutation;
 *   the filesystem is untouched; `fileHashes` is empty.
 * - `outcome: "rolled_back"`: one or more operations failed during apply;
 *   all earlier mutations were restored from snapshots with zero errors and
 *   any newly created files/directories removed; `fileHashes` reflects the
 *   restored state.
 * - `outcome: "rollback_failed"`: one or more operations failed during apply
 *   and the rollback itself could not fully restore the pre-batch state
 *   (e.g. a disk write failed mid-rollback, or a temp file could not be
 *   removed). `rollbackErrors` enumerates every rollback failure and the
 *   residual temp files that could not be removed. The caller MUST surface
 *   this outcome loudly: the filesystem is NOT guaranteed pristine.
 */
export interface BatchApplyResult {
  outcome: "applied" | "rejected" | "rolled_back" | "rollback_failed";
  outcomes: OperationOutcome[];
  /**
   * Before/after SHA-256 hashes for every file touched, keyed by
   * `skillName/relPath`. `before` is `null` for newly created files;
   * `after` is `null` for removed files. Empty when rejected.
   */
  fileHashes: Map<string, FileHashPair>;
  /** A human-readable reason when the batch was rejected or rolled back. */
  rejectionReason?: string;
  /**
   * Populated only when `outcome` is `"rollback_failed"`: one entry per
   * restoration/removal/temp-file-cleanup failure encountered while
   * rolling back. Each entry is a descriptive message identifying the skill
   * and the path that could not be restored or removed.
   */
  rollbackErrors?: string[];
}

// ===========================================================================
// Manager options
// ===========================================================================

export interface SkillManagerOptions {
  /**
   * Fault-injection hook, called before each operation in the apply phase.
   * Dependency-injected for tests; production callers omit it.
   */
  faultInjector?: FaultInjector;
  /**
   * Override the snapshot-restore implementation used during rollback.
   * Dependency-injected for tests so a test can make restoration fail
   * after an earlier operation has already mutated state. Production
   * callers never set this.
   */
  restoreSkillImpl?: RestoreSkillFn;
}

type BatchContext = { queueId: string; sourceAgentId: string; turnId: string };
type BatchApplyContext = BatchContext & { claimIsCurrent?: () => boolean };
export type BatchReconciliation =
  | { outcome: "none" }
  | { outcome: "applied"; operationsHash: string; operationCount: number; skillNames: string[] }
  | { outcome: "reconciliation_required"; operationsHash?: string; operationCount?: number; skillNames?: string[] };

// ===========================================================================
// SkillManager
// ===========================================================================

/**
 * The guarded atomic skill manager.
 *
 * Protocol for {@link applyBatch}:
 *
 * 1. **Validate** the whole batch (op count, skill names, path containment,
 *    frontmatter, provenance, read-set evidence) against the *current*
 *    filesystem state. Any failure rejects the batch with no mutation.
 *
 * 2. **Lock**: acquire per-skill locks in stable (lexicographic) order. This
 *    serializes concurrent batches touching the same skills and prevents
 *    deadlock.
 *
 * 3. **Snapshot**: with all locks held, snapshot every touched skill. Because
 *    the locks are held, no concurrent process can modify these skills
 *    between the snapshot and the apply, resolving the TOCTOU window.
 *
 * 4. **Re-validate against the snapshot**: the logical batch is validated
 *    against the *snapshot* (the locked state), not a second unconstrained
 *    read. Read-set evidence hashes are checked against the snapshot hashes.
 *
 * 5. **Apply**: execute each operation against the snapshot-derived virtual
 *    state. Writes use temp-file + atomic rename. Before every file
 *    create/write/remove and archive move, the target's deepest existing
 *    ancestor is re-resolved with `realpathSync` and verified to stay inside
 *    the canonical real skill root, so a symlink swapped into place between
 *    snapshot and write cannot escape the root (F-2).
 *
 * 6. **Rollback or commit**: on any apply failure, every snapshot is
 *    restored and any newly created files/directories are removed, plus any
 *    temp files this process created during the batch. A rollback that
 *    reports any error — a failed file restore, a failed temp removal, or a
 *    failed archive un-move — yields the distinct `"rollback_failed"` outcome
 *    with `rollbackErrors`, never a clean `"rolled_back"` (F-1). On success,
 *    the locks are released and the batch is committed.
 */
export class SkillManager {
  private readonly skillRoot: string;
  private readonly faultInjector?: FaultInjector;
  private readonly restoreSkillImpl: RestoreSkillFn;
  /** Every temp file this process created during the current batch, for exact rollback cleanup. */
  private readonly createdTempFiles = new Set<string>();
  /** The archive directory this batch may have created. */
  private archiveDirCreated = false;

  constructor(skillRoot: string, options: SkillManagerOptions = {}) {
    const resolvedRoot = resolve(skillRoot);
    mkdirSync(resolvedRoot, { recursive: true });
    this.skillRoot = realpathSync(resolvedRoot);
    this.faultInjector = options.faultInjector;
    this.restoreSkillImpl = options.restoreSkillImpl ?? restoreSkill;
  }

  /** The canonical skill root. */
  get root(): string {
    return this.skillRoot;
  }

  /**
   * Apply a batch of operations atomically. See the class doc for the full
   * protocol.
   */
  async applyBatch(
    operations: SkillOperation[],
    readSet: ReadSetEntry[],
    context: BatchApplyContext,
  ): Promise<BatchApplyResult> {
    this.createdTempFiles.clear();

    // -- Phase 1: validate the whole batch (no mutation) --
    const rejected = this.preflight(operations, readSet);

    const skillNames = [...new Set(operations.map((op) => op.skillName))];
    const lockNames = [this.queueLockName(context.queueId), ...skillNames];

    // -- Phase 2: acquire the queue lock plus per-skill locks in stable order --
    let locks: SkillLock[];
    try {
      locks = await acquireSkillLocks(this.skillRoot, lockNames);
    } catch (e) {
      return {
        outcome: "rejected",
        outcomes: operations.map((op, i) => ({
          index: i,
          type: op.type,
          skillName: op.skillName,
          status: "skipped",
          error: `lock acquisition failed: ${e instanceof Error ? e.message : String(e)}`,
        })),
        fileHashes: new Map(),
        rejectionReason: `lock acquisition failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    try {
      // A concurrent worker may have committed this exact queue batch while
      // this caller waited for the skill locks. Recheck under the locks before
      // honoring a preflight conflict or touching the filesystem.
      const lockedReceipt = this.readAppliedReceipt(context, operations);
      if (lockedReceipt !== null) {
        return {
          outcome: "applied",
          outcomes: operations.map((op, index) => ({
            index,
            type: op.type,
            skillName: op.skillName,
            status: "applied",
          })),
          fileHashes: lockedReceipt,
        };
      }
      if (rejected) {
        return {
          outcome: "rejected",
          outcomes: operations.map((op, i) => ({
            index: i,
            type: op.type,
            skillName: op.skillName,
            status: "skipped",
            error: rejected,
          })),
          fileHashes: new Map(),
          rejectionReason: rejected,
        };
      }

      // -- Phase 3: snapshot every touched skill (locks held) --
      const snapshots = new Map<string, SkillSnapshot>();
      for (const name of skillNames) {
        snapshots.set(name, snapshotSkill(this.skillRoot, name));
      }

      // -- Phase 4: re-validate the logical batch against the locked
      //    snapshots (TOCTOU resolution) --
      const snapshotRejection = this.validateAgainstSnapshots(operations, readSet, snapshots);
      if (snapshotRejection) {
        return {
          outcome: "rejected",
          outcomes: operations.map((op, i) => ({
            index: i,
            type: op.type,
            skillName: op.skillName,
            status: "skipped",
            error: snapshotRejection,
          })),
          fileHashes: new Map(),
          rejectionReason: snapshotRejection,
        };
      }

      // -- Phase 5: durably journal the expected transition, then apply --
      const virtual = this.buildVirtualState(snapshots);
      const fileHashes = this.planFileHashes(operations, snapshots);
      this.writeBatchIntent(context, operations, fileHashes);

      const outcomes: OperationOutcome[] = [];
      let failedIndex = -1;

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];

        if (context.claimIsCurrent && !context.claimIsCurrent()) {
          failedIndex = i;
          outcomes.push({
            index: i,
            type: op.type,
            skillName: op.skillName,
            status: "failed",
            error: "queue claim is no longer current",
          });
          break;
        }


        // Fault injection (tests only; production omits this).
        if (this.faultInjector) {
          try {
            this.faultInjector(i, op);
          } catch (e) {
            failedIndex = i;
            outcomes.push({
              index: i,
              type: op.type,
              skillName: op.skillName,
              status: "failed",
              error: `fault injected: ${e instanceof Error ? e.message : String(e)}`,
            });
            break;
          }
        }

        try {
          await this.applyOne(op, virtual, fileHashes, snapshots);
          outcomes.push({ index: i, type: op.type, skillName: op.skillName, status: "applied" });
        } catch (e) {
          failedIndex = i;
          outcomes.push({
            index: i,
            type: op.type,
            skillName: op.skillName,
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
          break;
        }
      }

      if (failedIndex === -1 && context.claimIsCurrent && !context.claimIsCurrent()) {
        failedIndex = operations.length;
      }

      // -- Phase 6: rollback or commit --
      if (failedIndex !== -1) {
        const rollbackErrors = this.rollbackAll(snapshots, fileHashes);
        if (rollbackErrors.length > 0) {
          return {
            outcome: "rollback_failed",
            outcomes,
            fileHashes,
            rejectionReason:
              `operation ${failedIndex} failed and the rollback could not fully ` +
              `restore the pre-batch state (${rollbackErrors.length} error(s))`,
            rollbackErrors,
          };
        }
        this.removeBatchIntent(context.queueId);
        // Carry the failing operation's structured, secret-safe error so the
        // rejection is diagnosable without forensic reproduction.
        const failedOutcome = outcomes.find((o) => o.status === "failed");
        return {
          outcome: "rolled_back",
          outcomes,
          fileHashes,
          rejectionReason:
            `operation ${failedIndex} failed` +
            (failedOutcome?.error ? `: ${failedOutcome.error}` : "") +
            "; all mutations rolled back",
        };
      }

      // Success: the virtual state IS the on-disk state after apply.
      // Refresh after hashes from the virtual state.
      for (const [key, pair] of fileHashes) {
        const [skillName, rel] = splitFileKey(key);
        const v = virtual.get(skillName);
        const content = v?.get(rel);
        pair.after = content === undefined || content === null ? null : sha256(content);
      }

      try {
        this.writeAppliedReceipt(context, operations, fileHashes);
      } catch (error) {
        const rollbackErrors = this.rollbackAll(snapshots, fileHashes);
        const receiptError = error instanceof Error ? error.name : "receipt-error";
        if (rollbackErrors.length > 0) {
          return {
            outcome: "rollback_failed",
            outcomes,
            fileHashes,
            rejectionReason: `receipt write failed (${receiptError}) and rollback failed`,
            rollbackErrors,
          };
        }
        this.removeBatchIntent(context.queueId);
        return {
          outcome: "rolled_back",
          outcomes,
          fileHashes,
          rejectionReason: `receipt write failed (${receiptError}); all mutations rolled back`,
        };
      }

      return { outcome: "applied", outcomes, fileHashes };
    } finally {
      // -- Release locks (reverse order) --
      releaseSkillLocks(locks);
    }
  }

  /** Reconcile a durable intent before rerunning a nondeterministic curator. */
  async reconcileBatch(context: BatchContext): Promise<BatchReconciliation> {
    let locks: SkillLock[] = [];
    try {
      locks = await acquireSkillLocks(this.skillRoot, [this.queueLockName(context.queueId)]);
      try {
        const receipt = this.readDurableRecord(this.receiptPath(context.queueId), context);
        if (receipt !== null) {
          return this.hashesMatch(receipt.fileHashes, "after")
            ? { outcome: "applied", operationsHash: receipt.operationsHash, operationCount: receipt.operationCount, skillNames: receipt.skillNames }
            : { outcome: "reconciliation_required", operationsHash: receipt.operationsHash, operationCount: receipt.operationCount, skillNames: receipt.skillNames };
        }
        const intent = this.readDurableRecord(this.intentPath(context.queueId), context);
        if (intent === null) return { outcome: "none" };
        if (this.hashesMatch(intent.fileHashes, "after")) {
          this.writeDurableRecord(
            this.receiptPath(context.queueId),
            context,
            intent.operationsHash,
            intent.fileHashes,
            intent.operationCount,
            intent.skillNames,
          );
          return { outcome: "applied", operationsHash: intent.operationsHash, operationCount: intent.operationCount, skillNames: intent.skillNames };
        }
        if (this.hashesMatch(intent.fileHashes, "before")) {
          this.removeBatchIntent(context.queueId);
          return { outcome: "none" };
        }
        return { outcome: "reconciliation_required", operationsHash: intent.operationsHash, operationCount: intent.operationCount, skillNames: intent.skillNames };
      } catch {
        return { outcome: "reconciliation_required" };
      }
    } finally {
      releaseSkillLocks(locks);
    }
  }

  private readDurableRecord(
    path: string,
    context: BatchContext,
  ): { operationsHash: string; operationCount: number; skillNames: string[]; fileHashes: Map<string, FileHashPair> } | null {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      queueId?: unknown;
      sourceAgentId?: unknown;
      turnId?: unknown;
      operationsHash?: unknown;
      operationCount?: unknown;
      skillNames?: unknown;
      fileHashes?: unknown;
    };
    if (
      parsed.queueId !== context.queueId ||
      parsed.sourceAgentId !== context.sourceAgentId ||
      parsed.turnId !== context.turnId ||
      typeof parsed.operationsHash !== "string" ||
      parsed.fileHashes === null ||
      typeof parsed.fileHashes !== "object" ||
      Array.isArray(parsed.fileHashes)
    ) {
      throw new Error("durable batch record does not match queue");
    }
    const hashes = new Map<string, FileHashPair>();
    for (const [key, value] of Object.entries(parsed.fileHashes)) {
      if (
        value === null || typeof value !== "object" || Array.isArray(value) ||
        !("before" in value) || !("after" in value)
      ) throw new Error("durable batch record is malformed");
      const pair = value as { before: unknown; after: unknown };
      if (
        (pair.before !== null && typeof pair.before !== "string") ||
        (pair.after !== null && typeof pair.after !== "string")
      ) throw new Error("durable batch record hashes are malformed");
      hashes.set(key, { before: pair.before, after: pair.after });
    }
    const fallbackSkills = [...new Set([...hashes.keys()].map((key) => splitFileKey(key)[0]))]
      .filter((name) => name !== ".archive")
      .sort();
    return {
      operationsHash: parsed.operationsHash,
      operationCount: typeof parsed.operationCount === "number" && Number.isInteger(parsed.operationCount)
        ? parsed.operationCount
        : fallbackSkills.length,
      skillNames: Array.isArray(parsed.skillNames) && parsed.skillNames.every((name) => typeof name === "string")
        ? [...new Set(parsed.skillNames as string[])].sort()
        : fallbackSkills,
      fileHashes: hashes,
    };
  }

  private hashesMatch(hashes: Map<string, FileHashPair>, side: "before" | "after"): boolean {
    for (const [key, pair] of hashes) {
      const [skillName, relPath] = splitFileKey(key);
      const absPath = join(this.skillRoot, skillName, relPath);
      const expected = pair[side];
      try {
        this.ensureContained(relPath, skillName);
        if (expected === null) {
          if (existsSync(absPath)) return false;
        } else if (!existsSync(absPath) || sha256(readFileSync(absPath, "utf8")) !== expected) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  private writeDurableRecord(
    path: string,
    context: BatchContext,
    operationsHash: string,
    fileHashes: Map<string, FileHashPair>,
    operationCount: number,
    skillNames: string[],
  ): void {
    const serializedHashes = Object.fromEntries(
      [...fileHashes.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
    atomicWrite(path, JSON.stringify({
      ...context,
      operationsHash,
      operationCount,
      skillNames: [...new Set(skillNames)].sort(),
      fileHashes: serializedHashes,
    }), (tmp) => this.createdTempFiles.add(tmp));
  }

  private readAppliedReceipt(
    context: { queueId: string; sourceAgentId: string; turnId: string },
    operations: SkillOperation[],
  ): Map<string, FileHashPair> | null {
    const path = this.receiptPath(context.queueId);
    if (!existsSync(path)) return null;

    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      queueId?: unknown;
      sourceAgentId?: unknown;
      turnId?: unknown;
      operationsHash?: unknown;
      fileHashes?: unknown;
    };
    if (
      parsed.queueId !== context.queueId ||
      parsed.sourceAgentId !== context.sourceAgentId ||
      parsed.turnId !== context.turnId ||
      parsed.operationsHash !== sha256(JSON.stringify(operations)) ||
      parsed.fileHashes === null ||
      typeof parsed.fileHashes !== "object" ||
      Array.isArray(parsed.fileHashes)
    ) {
      throw new Error("applied receipt does not match queue batch");
    }

    const hashes = new Map<string, FileHashPair>();
    for (const [key, value] of Object.entries(parsed.fileHashes)) {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("before" in value) ||
        !("after" in value)
      ) {
        throw new Error("applied receipt is malformed");
      }
      const pair = value as { before: unknown; after: unknown };
      if (
        (pair.before !== null && typeof pair.before !== "string") ||
        (pair.after !== null && typeof pair.after !== "string")
      ) {
        throw new Error("applied receipt hashes are malformed");
      }
      hashes.set(key, { before: pair.before, after: pair.after });
    }

    for (const [key, pair] of hashes) {
      const [skillName, relPath] = splitFileKey(key);
      const absPath = join(this.skillRoot, skillName, relPath);
      try {
        this.ensureContained(relPath, skillName);
        if (pair.after === null) {
          if (existsSync(absPath)) throw new Error("present");
        } else if (!existsSync(absPath) || sha256(readFileSync(absPath, "utf8")) !== pair.after) {
          throw new Error("hash");
        }
      } catch {
        throw new Error("applied receipt state drifted; reconciliation required");
      }
    }
    return hashes;
  }

  private writeAppliedReceipt(
    context: BatchContext,
    operations: SkillOperation[],
    fileHashes: Map<string, FileHashPair>,
  ): void {
    this.writeDurableRecord(
      this.receiptPath(context.queueId),
      context,
      sha256(JSON.stringify(operations)),
      fileHashes,
      operations.length,
      operations.map((operation) => operation.skillName),
    );
  }

  private writeBatchIntent(
    context: BatchContext,
    operations: SkillOperation[],
    fileHashes: Map<string, FileHashPair>,
  ): void {
    this.writeDurableRecord(
      this.intentPath(context.queueId),
      context,
      sha256(JSON.stringify(operations)),
      fileHashes,
      operations.length,
      operations.map((operation) => operation.skillName),
    );
  }

  private removeBatchIntent(queueId: string): void {
    const path = this.intentPath(queueId);
    if (existsSync(path)) rmSync(path);
  }

  private queueLockName(queueId: string): string {
    return `queue-${sha256(queueId).slice(0, 32)}`;
  }

  private intentPath(queueId: string): string {
    this.validateRecordPath(queueId);
    const path = join(this.skillRoot, ".paseo-curator", "intents", `${queueId}.json`);
    verifyContained(this.skillRoot, path);
    return path;
  }

  private receiptPath(queueId: string): string {
    this.validateRecordPath(queueId);
    const path = join(this.skillRoot, ".paseo-curator", "receipts", `${queueId}.json`);
    verifyContained(this.skillRoot, path);
    return path;
  }

  private validateRecordPath(queueId: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(queueId)) {
      throw new Error("invalid queue id for durable batch record");
    }
    if (realpathSync(this.skillRoot) !== this.skillRoot) {
      throw new Error("skill root identity changed");
    }
  }

  // ---------------------------------------------------------------------
  // Preflight: validate the batch against the current (pre-lock) filesystem
  // ---------------------------------------------------------------------

  /**
   * Validate the whole batch before any mutation. Returns `null` if valid, or
   * a rejection reason string.
   *
   * This is the first line of defense. It checks against the live filesystem
   * *before* locks are acquired. The authoritative validation happens in
   * {@link validateAgainstSnapshots} after the locks are held.
   */
  private preflight(operations: SkillOperation[], readSet: ReadSetEntry[]): string | null {
    if (operations.length > 20) {
      return `batch exceeds the 20-operation limit (got ${operations.length})`;
    }
    if (operations.length === 0) {
      return "batch is empty";
    }

    const readSetMap = buildReadSetMap(readSet);

    for (const op of operations) {
      // Skill name.
      try {
        validateSkillName(op.skillName);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }

      switch (op.type) {
        case "create": {
          try {
            // Validate the content the plugin will actually write: provenance
            // is stamped by the manager, never trusted from the model, and
            // the stamped result is verified, not assumed.
            validateFrontmatter(op.skillName, stampCuratorProvenance(op.content), {
              expectCreatedBy: CURATOR_PROVENANCE,
            });
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          const skillDir = join(this.skillRoot, op.skillName);
          if (existsSync(skillDir)) {
            return `create: skill directory already exists: ${op.skillName}`;
          }
          break;
        }

        case "patch": {
          const pathErr = this.checkPath(op.skillName, op.path);
          if (pathErr) return pathErr;
          break;
        }

        case "write_file": {
          const pathErr = this.checkPath(op.skillName, op.path);
          if (pathErr) return pathErr;
          // SKILL.md owns provenance and frontmatter structure; recreating
          // it through write_file (e.g. after remove_file) would bypass the
          // stamping and validation the create and patch paths enforce.
          if (op.path === "SKILL.md") {
            return `write_file: cannot target SKILL.md: ${op.skillName} (use create or patch)`;
          }
          break;
        }

        case "remove_file": {
          const pathErr = this.checkPath(op.skillName, op.path);
          if (pathErr) return pathErr;
          break;
        }

        case "archive": {
          const err = this.checkArchiveEligible(op.skillName);
          if (err) return err;
          break;
        }
      }
    }

    return null;
  }

  /**
   * Validate the batch against the locked snapshots (TOCTOU-safe).
   *
   * Every existence/uniqueness/staleness check is performed against the
   * snapshot data, not the live filesystem. This is the authoritative
   * validation: if the filesystem changed between the curator agent's read
   * and now, the snapshot hash will not match the read-set evidence hash and
   * the batch is rejected.
   */
  private validateAgainstSnapshots(
    operations: SkillOperation[],
    readSet: ReadSetEntry[],
    snapshots: Map<string, SkillSnapshot>,
  ): string | null {
    const readSetMap = buildReadSetMap(readSet);

    // Build a virtual view of the skills as they will be after this batch,
    // starting from the snapshots.
    const virtual = this.buildVirtualState(snapshots);

    for (const op of operations) {
      switch (op.type) {
        case "create": {
          // The skill must not exist in the snapshot (and the directory must
          // not exist on disk — but we already checked that in preflight;
          // the snapshot is authoritative here).
          const snap = snapshots.get(op.skillName);
          if (snap && snap.existed) {
            return `create: skill already exists: ${op.skillName}`;
          }
          // The frontmatter must be valid and the content must match what
          // will be written (with plugin-stamped, verified provenance).
          try {
            validateFrontmatter(op.skillName, stampCuratorProvenance(op.content), {
              expectCreatedBy: CURATOR_PROVENANCE,
            });
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          // Verify no other op in the batch already created this skill.
          if (virtual.has(op.skillName)) {
            return `create: skill already created earlier in this batch: ${op.skillName}`;
          }
          break;
        }

        case "patch": {
          const err = this.validatePatch(op, virtual);
          if (err) return err;
          break;
        }

        case "write_file": {
          const err = this.validateWriteFile(op, virtual);
          if (err) return err;
          break;
        }

        case "remove_file": {
          const err = this.validateRemoveFile(op, virtual);
          if (err) return err;
          break;
        }

        case "archive": {
          const err = this.validateArchive(op, snapshots);
          if (err) return err;
          break;
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------
  // Per-operation validation against virtual state
  // ---------------------------------------------------------------------

  private checkPath(skillName: string, path: string): string | null {
    try {
      resolveSkillPath(this.skillRoot, skillName, path);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return null;
  }

  private checkArchiveEligible(skillName: string): string | null {
    const skillMdPath = join(this.skillRoot, skillName, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      return `archive: skill does not exist: ${skillName}`;
    }
    let content: string;
    try {
      content = readFileSync(skillMdPath, "utf8");
    } catch {
      return `archive: cannot read SKILL.md for ${skillName}`;
    }
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      return `archive: ${skillName} has no frontmatter (provenance unknown)`;
    }
    if (parsed.frontmatter.createdBy !== "paseo-curator") {
      return `archive: ${skillName} is not curator-owned (created_by: ${parsed.frontmatter.createdBy ?? "unknown"})`;
    }
    return null;
  }

  private validatePatch(
    op: Extract<SkillOperation, { type: "patch" }>,
    virtual: Map<string, Map<string, string | null>>,
  ): string | null {
    const skillVirtual = virtual.get(op.skillName);
    if (!skillVirtual) {
      return `patch: skill does not exist: ${op.skillName}`;
    }
    const current = skillVirtual.get(op.path);
    if (current === null || current === undefined) {
      return `patch: file does not exist: ${op.skillName}/${op.path}`;
    }

    // `current` is the content captured under the skill lock, so it is the
    // authoritative read-before-write snapshot; no model-supplied digest is
    // trusted here.

    // The patch must match uniquely.
    const occurrences = countOccurrences(current, op.oldText);
    if (occurrences === 0) {
      return `patch: oldText not found in ${op.skillName}/${op.path}`;
    }
    if (occurrences > 1) {
      return `patch: oldText is not unique in ${op.skillName}/${op.path} (${occurrences} occurrences)`;
    }

    return null;
  }

  private validateWriteFile(
    op: Extract<SkillOperation, { type: "write_file" }>,
    virtual: Map<string, Map<string, string | null>>,
  ): string | null {
    const skillVirtual = virtual.get(op.skillName);
    if (skillVirtual === undefined) {
      return `write_file: skill does not exist: ${op.skillName}`;
    }
    // SKILL.md cannot be recreated through write_file: it would bypass the
    // provenance stamping and frontmatter validation the create path owns.
    if (op.path === "SKILL.md") {
      return `write_file: cannot target SKILL.md: ${op.skillName} (use create or patch)`;
    }
    const existing = skillVirtual.get(op.path);
    if (existing !== undefined && existing !== null) {
      return `write_file: file already exists: ${op.skillName}/${op.path}`;
    }
    return null;
  }

  private validateRemoveFile(
    op: Extract<SkillOperation, { type: "remove_file" }>,
    virtual: Map<string, Map<string, string | null>>,
  ): string | null {
    const skillVirtual = virtual.get(op.skillName);
    if (!skillVirtual) {
      return `remove_file: skill does not exist: ${op.skillName}`;
    }
    const current = skillVirtual.get(op.path);
    if (current === undefined || current === null) {
      return `remove_file: file does not exist: ${op.skillName}/${op.path}`;
    }
    return null;
  }

  private validateArchive(
    op: Extract<SkillOperation, { type: "archive" }>,
    snapshots: Map<string, SkillSnapshot>,
  ): string | null {
    const snap = snapshots.get(op.skillName);
    if (!snap || !snap.existed) {
      return `archive: skill does not exist: ${op.skillName}`;
    }
    const skillMd = snap.files.get("SKILL.md");
    if (skillMd === undefined) {
      return `archive: ${op.skillName} has no SKILL.md`;
    }
    const parsed = parseFrontmatter(skillMd);
    if (!parsed) {
      return `archive: ${op.skillName} has no frontmatter (provenance unknown)`;
    }
    if (parsed.frontmatter.createdBy !== "paseo-curator") {
      return `archive: ${op.skillName} is not curator-owned (created_by: ${parsed.frontmatter.createdBy ?? "unknown"})`;
    }
    // The archive destination must not already exist.
    const archiveDirExists = existsSync(join(this.skillRoot, ".archive", op.skillName));
    if (archiveDirExists) {
      return `archive: archive destination already exists for ${op.skillName}`;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Virtual state
  // ---------------------------------------------------------------------

  /**
   * Build the virtual file map for each skill from the snapshots. This is the
   * state the apply phase reads and writes. It is a pure in-memory view; the
   * apply phase applies operations *to this map* and then persists the
   * results to disk, so the apply phase never re-reads the filesystem for
   * content it has already validated.
   */
  private buildVirtualState(
    snapshots: Map<string, SkillSnapshot>,
  ): Map<string, Map<string, string | null>> {
    const virtual = new Map<string, Map<string, string | null>>();
    for (const [name, snap] of snapshots) {
      // Only create a virtual entry for skills that existed. A skill that
      // did not exist (a create target) gets no entry here; the create
      // operation will add one.
      if (!snap.existed) continue;
      const files = new Map<string, string | null>();
      for (const [rel, content] of snap.files) {
        files.set(rel, content);
      }
      virtual.set(name, files);
    }
    return virtual;
  }

  private planFileHashes(
    operations: SkillOperation[],
    snapshots: Map<string, SkillSnapshot>,
  ): Map<string, FileHashPair> {
    const virtual = this.buildVirtualState(snapshots);
    const hashes = new Map<string, FileHashPair>();
    for (const [name, snap] of snapshots) {
      for (const [rel, content] of snap.files) {
        hashes.set(`${name}/${rel}`, { before: sha256(content), after: sha256(content) });
      }
    }
    for (const op of operations) {
      switch (op.type) {
        case "create": {
          const files = virtual.get(op.skillName) ?? new Map<string, string | null>();
          files.set("SKILL.md", stampCuratorProvenance(op.content));
          virtual.set(op.skillName, files);
          break;
        }
        case "patch": {
          const files = virtual.get(op.skillName)!;
          files.set(op.path, files.get(op.path)!.replace(op.oldText, op.newText));
          break;
        }
        case "write_file": {
          const files = virtual.get(op.skillName) ?? new Map<string, string | null>();
          files.set(op.path, op.content);
          virtual.set(op.skillName, files);
          break;
        }
        case "remove_file":
          virtual.get(op.skillName)!.set(op.path, null);
          break;
        case "archive": {
          const files = virtual.get(op.skillName) ?? new Map<string, string | null>();
          const archive = virtual.get(".archive") ?? new Map<string, string | null>();
          for (const [rel, content] of files) archive.set(`${op.skillName}/${rel}`, content);
          virtual.set(".archive", archive);
          virtual.set(op.skillName, new Map());
          break;
        }
      }
    }
    for (const [name, files] of virtual) {
      for (const [rel, content] of files) {
        const key = `${name}/${rel}`;
        const pair = hashes.get(key) ?? { before: null, after: null };
        pair.after = content === null ? null : sha256(content);
        hashes.set(key, pair);
      }
    }
    for (const [key, pair] of hashes) {
      const [name, rel] = splitFileKey(key);
      const content = virtual.get(name)?.get(rel);
      pair.after = content === undefined || content === null ? null : sha256(content);
    }
    return hashes;
  }

  // ---------------------------------------------------------------------
  // Containment re-check (F-2)
  // ---------------------------------------------------------------------

  /**
   * Re-verify that the parent directory of `absPath` is physically inside
   * the canonical real skill root. Fails closed (throws a
   * {@link PathEscapeError}) if the deepest existing ancestor resolves
   * outside the real root — the signature of a symlink swapped into place
   * after the preflight/snapshot checks ran.
   *
   * Must be called with all relevant locks held, immediately before every
   * file create/write/remove and archive move.
   */
  private ensureContained(relPath: string, skillName: string): void {
    const absPath = join(this.skillRoot, skillName, relPath);
    verifyContained(this.skillRoot, absPath);
  }

  // ---------------------------------------------------------------------
  // Apply one operation to the virtual state, then persist
  // ---------------------------------------------------------------------

  /**
   * Apply a single operation: compute the new virtual content, then persist
   * it to disk atomically. On persistence failure, throws (the caller
   * triggers rollback).
   */
  private async applyOne(
    op: SkillOperation,
    virtual: Map<string, Map<string, string | null>>,
    fileHashes: Map<string, { before: string | null; after: string | null }>,
    snapshots: Map<string, SkillSnapshot>,
  ): Promise<void> {
    const skillDir = join(this.skillRoot, op.skillName);

    switch (op.type) {
      case "create": {
        // Provenance is stamped by the plugin, never trusted from the model:
        // the written file always carries created_by: paseo-curator.
        const content = stampCuratorProvenance(op.content);
        // Update the virtual state.
        const files = virtual.get(op.skillName) ?? new Map<string, string | null>();
        files.set("SKILL.md", content);
        virtual.set(op.skillName, files);

        // Re-check containment at write time (F-2).
        this.ensureContained("SKILL.md", op.skillName);

        // Persist: create the skill directory and write SKILL.md atomically.
        const skillMdPath = join(skillDir, "SKILL.md");
        atomicCreate(skillMdPath, content, (tmp) => this.createdTempFiles.add(tmp));

        // Record the hash.
        const key = `${op.skillName}/SKILL.md`;
        fileHashes.set(key, { before: null, after: sha256(content) });
        break;
      }

      case "patch": {
        const files = virtual.get(op.skillName)!;
        const current = files.get(op.path);
        if (current === null || current === undefined) {
          throw new Error(`patch: file does not exist in virtual state: ${op.skillName}/${op.path}`);
        }
        const occurrences = countOccurrences(current, op.oldText);
        if (occurrences === 0) {
          throw new Error(`patch: oldText not found in ${op.skillName}/${op.path}`);
        }
        if (occurrences > 1) {
          throw new Error(
            `patch: oldText is not unique in ${op.skillName}/${op.path} (${occurrences} occurrences)`,
          );
        }
        const updated = current.replace(op.oldText, op.newText);
        files.set(op.path, updated);

        // If the patch targets SKILL.md, validate the frontmatter is
        // preserved (name unchanged, created_by invariant).
        if (op.path === "SKILL.md") {
          validateFrontmatterPreserved(op.skillName, current, updated);
        }

        // Re-check containment at write time (F-2).
        this.ensureContained(op.path, op.skillName);

        const absPath = join(skillDir, op.path);
        atomicWrite(absPath, updated, (tmp) => this.createdTempFiles.add(tmp));

        const key = `${op.skillName}/${op.path}`;
        const existing = fileHashes.get(key);
        fileHashes.set(key, {
          before: existing?.before ?? sha256(current),
          after: sha256(updated),
        });
        break;
      }

      case "write_file": {
        const files = virtual.get(op.skillName) ?? new Map<string, string | null>();
        if (files.has(op.path) && files.get(op.path) !== null) {
          throw new Error(`write_file: file already exists: ${op.skillName}/${op.path}`);
        }
        // Write-time defense (F-2 style): SKILL.md must never be recreated
        // through write_file; preflight and snapshot validation reject it,
        // and this guard holds even if they were bypassed.
        if (op.path === "SKILL.md") {
          throw new Error(`write_file: cannot target SKILL.md: ${op.skillName} (use create or patch)`);
        }
        files.set(op.path, op.content);
        virtual.set(op.skillName, files);

        // Re-check containment at write time (F-2).
        this.ensureContained(op.path, op.skillName);

        const absPath = join(skillDir, op.path);
        atomicCreate(absPath, op.content, (tmp) => this.createdTempFiles.add(tmp));

        const key = `${op.skillName}/${op.path}`;
        fileHashes.set(key, { before: null, after: sha256(op.content) });
        break;
      }

      case "remove_file": {
        const files = virtual.get(op.skillName) ?? new Map<string, string | null>();
        if (!files.has(op.path) || files.get(op.path) === null) {
          throw new Error(`remove_file: file does not exist: ${op.skillName}/${op.path}`);
        }
        files.set(op.path, null);
        virtual.set(op.skillName, files);

        // Re-check containment at remove time (F-2).
        this.ensureContained(op.path, op.skillName);

        const absPath = join(skillDir, op.path);
        if (existsSync(absPath)) {
          // Remove the file (not the directory tree).
          removeSingleFile(absPath);
        }

        const key = `${op.skillName}/${op.path}`;
        const existing = fileHashes.get(key);
        fileHashes.set(key, {
          before: existing?.before ?? null,
          after: null,
        });
        break;
      }

      case "archive": {
        // The archive operation moves the skill directory to .archive/.
        const srcDir = skillDir;
        const dstDir = join(this.skillRoot, ".archive", op.skillName);

        // Re-check containment of both the source and the destination at
        // move time (F-2). A swap that turned the skill directory itself
        // into a symlink is caught by the source check; a swap that turned
        // the .archive directory into a symlink is caught by the dest check.
        verifyContained(this.skillRoot, srcDir);
        verifyContained(this.skillRoot, dstDir);

        const archiveParent = join(this.skillRoot, ".archive");
        if (!existsSync(archiveParent)) {
          mkdirSync(archiveParent, { recursive: true });
          this.archiveDirCreated = true;
        }

        atomicMoveDir(srcDir, dstDir);

        // Record hashes for the moved files (content is unchanged, only the
        // location changes). Read from the snapshot that was passed in.
        const snapFiles = snapshots.get(op.skillName)?.files ?? new Map();
        const archiveVirtual = virtual.get(".archive") ?? new Map<string, string | null>();
        for (const [rel, fileContent] of snapFiles) {
          const sourceKey = `${op.skillName}/${rel}`;
          fileHashes.set(sourceKey, { before: sha256(fileContent), after: null });
          const archiveRel = `${op.skillName}/${rel}`;
          archiveVirtual.set(archiveRel, fileContent);
          fileHashes.set(`.archive/${archiveRel}`, { before: null, after: sha256(fileContent) });
        }
        virtual.set(".archive", archiveVirtual);

        // Clear the virtual state for this skill (it no longer exists in its
        // original location).
        virtual.set(op.skillName, new Map());
        break;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Rollback
  // ---------------------------------------------------------------------

  /**
   * Roll back all mutations: restore every snapshot, remove any temp files
   * this process created during the batch, and — if an archive moved a skill
   * out of the root — move it back.
   *
   * Returns a list of human-readable rollback failures. An empty list means
   * the rollback fully restored the pre-batch state and the batch outcome is
   * `"rolled_back"`. A non-empty list means the batch outcome is
   * `"rollback_failed"` — the caller must surface this loudly because the
   * filesystem is NOT guaranteed pristine.
   */
  private rollbackAll(
    snapshots: Map<string, SkillSnapshot>,
    fileHashes: Map<string, { before: string | null; after: string | null }>,
  ): string[] {
    const errors: string[] = [];

    // First: undo any archive moves in this batch (the skill dir must come
    // back before restoreSkill touches its old location).
    for (const [name, snap] of snapshots) {
      if (!snap.existed) continue;
      const srcDir = join(this.skillRoot, name);
      const dstDir = join(this.skillRoot, ".archive", name);
      if (existsSync(dstDir) && !existsSync(srcDir)) {
        try {
          atomicMoveDir(dstDir, srcDir);
        } catch (e) {
          errors.push(`archive un-move ${name}: ${errMsg(e)}`);
        }
      }
    }

    // Then: restore every skill from its snapshot.
    for (const [name, snap] of snapshots) {
      const result = this.restoreSkillImpl(this.skillRoot, snap);
      for (const err of result.errors) {
        errors.push(err);
      }
      // Reset the after hashes to the restored state.
      for (const key of fileHashes.keys()) {
        if (key.startsWith(`${name}/`)) {
          const pair = fileHashes.get(key)!;
          const [, rel] = splitFileKey(key);
          const restoredContent = snap.existed ? snap.files.get(rel) : undefined;
          pair.after = restoredContent !== undefined ? sha256(restoredContent) : null;
        }
      }
    }

    // Then: remove exactly the temp files this process created during the
    // batch (tracked in createdTempFiles; never a broad glob, so pre-existing
    // dotfiles are never deleted).
    for (const tmp of this.createdTempFiles) {
      try {
        if (existsSync(tmp)) {
          rmSync(tmp, { force: true });
        }
      } catch (e) {
        errors.push(`temp file removal failed: ${tmp}: ${errMsg(e)}`);
      }
    }

    // Finally: if this batch created the .archive directory and it is now
    // empty, remove it so the root is exactly as it was.
    if (this.archiveDirCreated) {
      const archiveParent = join(this.skillRoot, ".archive");
      try {
        if (existsSync(archiveParent) && readdirSync(archiveParent).length === 0) {
          rmdirSync(archiveParent);
        }
      } catch (e) {
        errors.push(`archive directory removal failed: ${archiveParent}: ${errMsg(e)}`);
      }
    }

    return errors;
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function buildReadSetMap(readSet: ReadSetEntry[]): Map<string, ReadSetEntry> {
  const map = new Map<string, ReadSetEntry>();
  for (const entry of readSet) {
    map.set(`${entry.skillName}/${entry.path}`, entry);
  }
  return map;
}

function splitFileKey(key: string): [string, string] {
  const idx = key.indexOf("/");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/** Remove a single file (not a directory tree). */
function removeSingleFile(absPath: string): void {
  try {
    rmSync(absPath, { force: true });
  } catch {
    // Best-effort; the file may already be gone.
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
