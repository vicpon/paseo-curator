import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";

import { CuratorStore, type StoreConfig } from "../server/store";
import { QueueRecordSchema } from "../server/contracts";
import type { PluginConfig } from "../server/contracts";

/**
 * Durable queue and cadence. Every test opens an isolated in-memory database
 * so the suite is deterministic and order-independent.
 */
const baseConfig: Partial<PluginConfig> = {
  reviewThreshold: 10,
  maxRetries: 3,
};

/**
 * A controllable clock for testing time-based recovery.
 * `nowMs` is the current epoch-millis the injected clock will report.
 */
class FakeClock {
  nowMs: number;
  constructor(startMs: number) {
    this.nowMs = startMs;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
  now(): Date {
    return new Date(this.nowMs);
  }
}

/** Store config with a controllable clock for recovery tests. */
function clockConfig(clock: FakeClock, staleAfterMs: number): StoreConfig {
  return {
    reviewThreshold: 10,
    maxRetries: 3,
    staleAfterMs,
    now: () => clock.now(),
  };
}

describe("CuratorStore", () => {
  describe("schema and lifecycle", () => {
    it("atomically fences terminal and rejected audits to the owning claim", () => {
      const clock = new FakeClock(Date.parse("2040-01-01"));
      const store = new CuratorStore(":memory:", clockConfig(clock, 100));
      const row = store.enqueue("agent", "turn")!;
      const stale = store.claim(row.id)!;
      clock.advance(101);
      store.recoverStaleRunning();
      const current = store.claim(row.id)!;
      const audit = { queueId: row.id, sourceAgentId: "agent", turnId: "turn",
        outcome: "nothing_to_save" as const, summary: "nothing to save", operationCount: 0,
        operationsHash: "a".repeat(64), skillNames: [] };
      expect(store.completeWithAudit(row.id, "nothing_to_save", stale.attempts, audit)).toBe(false);
      expect(store.recordAuditIfClaimCurrent(row.id, stale.attempts, { ...audit, outcome: "rejected", rejectionReason: "stale" })).toBe(false);
      expect(store.listAudit()).toEqual([]);
      expect(() => store.completeWithAudit(row.id, "nothing_to_save", current.attempts, { ...audit, operationsHash: "invalid" })).toThrow();
      expect(store.isClaimCurrent(row.id, current.attempts)).toBe(true);
      expect(store.listAudit()).toEqual([]);
      expect(store.completeWithAudit(row.id, "nothing_to_save", current.attempts, audit)).toBe(true);
      expect(store.get("agent", "turn")?.status).toBe("nothing_to_save");
      expect(store.listAudit().map(a => a.outcome)).toEqual(["nothing_to_save"]);
      store.close();
    });
    it("preserves distinct repaired submissions and later rollback failure while deduplicating identical rejection", () => {
      const store = new CuratorStore(":memory:");
      try {
        const row = store.enqueue("source", "turn")!;
        const claim = store.claim(row.id)!;
        const first = { queueId: row.id, sourceAgentId: "source", turnId: "turn", outcome: "rejected" as const,
          summary: "batch rejected", operationCount: 1, operationsHash: "a".repeat(64), skillNames: ["alpha"],
          rejectionReason: "apply outcome: rejected; oldText not found" };
        const repaired = { ...first, operationCount: 2, operationsHash: "b".repeat(64), skillNames: ["alpha", "beta"],
          rejectionReason: "apply outcome: rejected; exact text mismatch" };
        const partial = { ...repaired, rejectionReason: "apply outcome: rollback_failed; reconciliation required" };
        for (const audit of [first, repaired, partial, partial]) {
          expect(store.recordAuditIfClaimCurrent(row.id, claim.attempts, audit)).toBe(true);
        }
        const audits = store.listAudit();
        expect(audits).toHaveLength(3);
        expect(audits.map(({ id: _id, timestamp: _timestamp, ...audit }) => audit)).toEqual([first, repaired, partial]);
        expect(store.fail(row.id, "rollback failed; reconciliation required", claim.attempts)).toBe(true);
        expect(store.recordAuditIfClaimCurrent(row.id, claim.attempts, { ...partial, operationsHash: "c".repeat(64) })).toBe(false);
        expect(store.listAudit()).toEqual(audits);
      } finally { store.close(); }
    });

    it("keeps success outcome audits idempotent even if a caller supplies another batch hash", () => {
      const store = new CuratorStore(":memory:");
      try {
        for (const outcome of ["applied", "nothing_to_save"] as const) {
          const audit = { queueId: "terminal", sourceAgentId: "source", turnId: "turn", outcome,
            summary: "terminal outcome", operationCount: 0, operationsHash: "a".repeat(64), skillNames: [] };
          store.recordAudit(audit);
          store.recordAudit({ ...audit, operationsHash: "b".repeat(64) });
        }
        expect(store.listAudit().map(row => [row.outcome, row.operationsHash])).toEqual([
          ["applied", "a".repeat(64)], ["nothing_to_save", "a".repeat(64)],
        ]);
      } finally { store.close(); }
    });

    it("upgrades v2 audit uniqueness without rewriting records or migration history across SQLite reopens", () => {
      const dbPath = `${process.env.TMPDIR ?? "/tmp"}/curator-audit-v3-${Date.now()}-${Math.random()}.sqlite`;
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (1,'2040-01-01'),(2,'2040-01-02');
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, queue_id TEXT NOT NULL, source_agent_id TEXT NOT NULL,
          turn_id TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('applied','rejected','nothing_to_save')),
          summary TEXT NOT NULL, operation_count INTEGER NOT NULL, operations_hash TEXT NOT NULL,
          skill_names_json TEXT NOT NULL, rejection_reason TEXT, created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX audit_log_terminal_outcome ON audit_log(queue_id,outcome);
        INSERT INTO audit_log VALUES
          (17,'q-rejected','source','turn','rejected','first rejection',1,'${"a".repeat(64)}','["alpha"]','oldText mismatch','2040-01-01'),
          (18,'q-applied','source','turn-2','applied','batch applied',1,'${"b".repeat(64)}','["alpha"]',NULL,'2040-01-02'),
          (19,'q-nothing','source','turn-3','nothing_to_save','nothing to save',0,'${"c".repeat(64)}','[]',NULL,'2040-01-03');
      `);
      const original = legacy.prepare("SELECT * FROM audit_log ORDER BY id").all();
      legacy.close();
      let store = new CuratorStore(dbPath);
      try {
        store.recordAudit({ queueId: "q-rejected", sourceAgentId: "source", turnId: "turn", outcome: "rejected",
          summary: "batch rejected", operationCount: 2, operationsHash: "d".repeat(64), skillNames: ["alpha", "beta"],
          rejectionReason: "apply outcome: rollback_failed; reconciliation required" });
        const expected = store.listAudit();
        expect(expected).toHaveLength(4);
        for (let i = 0; i < 2; i++) {
          store.close();
          store = new CuratorStore(dbPath);
          expect(store.listAudit()).toEqual(expected);
        }
        const inspect = new DatabaseSync(dbPath);
        try {
          expect(inspect.prepare("SELECT * FROM audit_log WHERE id <= 19 ORDER BY id").all()).toEqual(original);
          expect(inspect.prepare("SELECT version, applied_at FROM schema_migrations WHERE version IN (1,2) ORDER BY version").all()).toEqual([
            { version: 1, applied_at: "2040-01-01" }, { version: 2, applied_at: "2040-01-02" },
          ]);
          expect(inspect.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
        } finally { inspect.close(); }
      } finally { store.close(); rmSync(dbPath, { force: true }); }
    });

    it("migrates legacy audit rows and backfills observed queued turns", () => {
      const dbPath = `${process.env.TMPDIR ?? "/tmp"}/curator-legacy-${Date.now()}-${Math.random()}.sqlite`;
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE queue (
          id TEXT PRIMARY KEY, source_agent_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          attempts INTEGER NOT NULL, started_at TEXT, completed_at TEXT, error TEXT,
          UNIQUE(source_agent_id, turn_id)
        );
        INSERT INTO queue VALUES ('q1','agent-old','turn-old','applied','2040-01-01','2040-01-01',1,NULL,'2040-01-01',NULL);
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, queue_id TEXT NOT NULL,
          outcome TEXT NOT NULL, skill_names_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO audit_log(queue_id,outcome,skill_names_json,created_at) VALUES
          ('q1','rolled_back','[]','2040-01-01'),
          ('q1','rollback_failed','[]','2040-01-02'),
          ('q2','nothing_to_save','[]','2040-01-03');
      `);
      legacy.close();

      const store = new CuratorStore(dbPath);
      expect(store.hasObservedTurn("agent-old", "turn-old")).toBe(true);
      expect(store.recordIteration("agent-old", 5, "turn-old")).toBe(true);
      expect(store.getCounter("agent-old")).toBe(0);
      expect(store.listAudit().map((row) => row.outcome).sort()).toEqual(["nothing_to_save", "rejected"]);
      store.close();
      rmSync(dbPath, { force: true });
    });

    it("persists exact audit outcomes and queue no-op success across real SQLite reopens", () => {
      const dbPath = `/tmp/curator-audit-${Date.now()}-${Math.random()}.sqlite`;
      let store = new CuratorStore(dbPath);
      try {
        const row = store.enqueue("agent", "turn")!;
        const claim = store.claim(row.id)!;
        for (const outcome of ["applied", "rejected", "nothing_to_save"] as const) {
          const audit = {
            queueId: row.id, sourceAgentId: "agent", turnId: "turn", outcome,
            ...(outcome === "rejected" ? { rejectionReason: "bounded rejection" } : {}),
            summary: "bounded", operationCount: 0, operationsHash: "a".repeat(64), skillNames: [],
          };
          store.recordAudit(audit);
          store.recordAudit(audit);
        }
        store.complete(row.id, "nothing_to_save", claim.attempts);
        expect(store.listAudit().map(row => row.outcome)).toEqual(["applied", "rejected", "nothing_to_save"]);
        for (let i = 0; i < 2; i++) {
          store.close();
          store = new CuratorStore(dbPath);
          expect(store.get("agent", "turn")?.status).toBe("nothing_to_save");
          expect(store.listAudit().map(row => row.outcome)).toEqual(["applied", "rejected", "nothing_to_save"]);
        }
      } finally {
        store.close();
        rmSync(dbPath, { force: true });
      }
    });

    it("upgrades restrictive legacy queue and audit CHECK constraints without losing identities", () => {
      const dbPath = `/tmp/curator-constrained-${Date.now()}-${Math.random()}.sqlite`;
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE queue (
          id TEXT PRIMARY KEY, source_agent_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','running','applied','failed')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL,
          started_at TEXT, completed_at TEXT, error TEXT, UNIQUE(source_agent_id,turn_id)
        );
        INSERT INTO queue VALUES ('q-old','agent','turn','pending','2040-01-01','2040-01-01',0,NULL,NULL,NULL);
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, queue_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('applied','rejected')),
          skill_names_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO audit_log VALUES (17,'q-before','applied','[]','2040-01-01');
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (1,'2040-01-01');
      `);
      legacy.close();
      let store = new CuratorStore(dbPath);
      try {
        const claim = store.claim("q-old")!;
        expect(store.complete(claim.id, "nothing_to_save", claim.attempts)).toBe(true);
        store.recordAudit({ queueId: claim.id, sourceAgentId: "agent", turnId: "turn",
          outcome: "nothing_to_save", summary: "no lesson", operationCount: 0,
          operationsHash: "a".repeat(64), skillNames: [] });
        store.close();
        store = new CuratorStore(dbPath);
        expect(store.get("agent", "turn")).toMatchObject({ id: "q-old", status: "nothing_to_save", attempts: 1 });
        expect(store.listAudit().map(row => [row.id, row.outcome])).toEqual([["17", "applied"], ["18", "nothing_to_save"]]);
      } finally {
        store.close();
        rmSync(dbPath, { force: true });
      }
    });

    it("accepts an explicit database path (including :memory:)", () => {
      const store = new CuratorStore(":memory:");
      store.recordIteration("agent-1", 1);
      expect(store.getCounter("agent-1")).toBe(1);
      store.close();
    });

    it("persists across open/close (durable on disk)", () => {
      const dbPath = `${process.env.TMPDIR ?? "/tmp"}/curator-test-${Date.now()}-${Math.random()}.sqlite`;
      {
        const store = new CuratorStore(dbPath);
        store.recordIteration("agent-1", 5);
        const q = store.enqueue("agent-1", "turn-1");
        expect(q).not.toBeNull();
        store.close();
      }
      {
        const store = new CuratorStore(dbPath);
        expect(store.getCounter("agent-1")).toBe(5);
        const rec = store.get("agent-1", "turn-1");
        expect(rec).not.toBeNull();
        expect(rec?.status).toBe("pending");
        store.close();
      }
    });

    it("records created/updated timestamps and an initial pending status", () => {
      const store = new CuratorStore(":memory:");
      store.recordIteration("agent-1", 10);
      const rec = store.get("agent-1", "turn-1");
      expect(rec).not.toBeNull();
      // QueueRecord schema must accept the row shape as it comes back from the store.
      expect(() => QueueRecordSchema.parse(rec!)).not.toThrow();
      expect(rec!.status).toBe("pending");
      expect(rec!.createdAt).toBe(rec!.updatedAt);
      expect(rec!.attempts).toBe(0);
      store.close();
    });
  });

  describe("unique (sourceAgentId, turnId) and enqueue idempotency", () => {
    it("does not create a duplicate row on repeated enqueue", () => {
      const store = new CuratorStore(":memory:");
      store.recordIteration("agent-1", 10);
      const first = store.enqueue("agent-1", "turn-1");
      const second = store.enqueue("agent-1", "turn-1");
      expect(first).not.toBeNull();
      // The duplicate is already durably present: returns the same row, same status.
      expect(second?.id).toBe(first!.id);
      expect(second?.status).toBe(first!.status);
      const rows = store.listAll();
      expect(rows.filter((r) => r.sourceAgentId === "agent-1" && r.turnId === "turn-1")).toHaveLength(1);
      store.close();
    });

    it("allows the same turnId across different agents", () => {
      const store = new CuratorStore(":memory:");
      store.recordIteration("agent-1", 10);
      store.recordIteration("agent-2", 10);
      const q1 = store.enqueue("agent-1", "turn-1");
      const q2 = store.enqueue("agent-2", "turn-1");
      expect(q1?.id).not.toBe(q2?.id);
      store.close();
    });
  });

  describe("10-iteration accumulation and threshold crossing", () => {
    it("accumulates across calls until the threshold is reached, then enqueues and resets", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      expect(store.recordIteration("agent-1", 6, "turn-1")).toBe(false);
      expect(store.getCounter("agent-1")).toBe(6);
      // 6 + 3 = 9 < 10
      expect(store.recordIteration("agent-1", 3, "turn-2")).toBe(false);
      expect(store.getCounter("agent-1")).toBe(9);
      // 9 + 1 = 10 == threshold -> enqueue
      const enq = store.recordIteration("agent-1", 1, "turn-3");
      expect(enq).toBe(true);
      const rec = store.get("agent-1", "turn-3");
      expect(rec?.status).toBe("pending");
      // Counter reset after durable enqueue.
      expect(store.getCounter("agent-1")).toBe(0);
      store.close();
    });

    it("crosses the threshold in one call (a single big turn)", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      const enq = store.recordIteration("agent-1", 15);
      expect(enq).toBe(true);
      expect(store.getCounter("agent-1")).toBe(0);
      expect(store.get("agent-1", "turn-1")?.status).toBe("pending");
      store.close();
    });

    it("does not accumulate below the threshold", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      expect(store.recordIteration("agent-1", 4, "turn-1")).toBe(false);
      expect(store.recordIteration("agent-1", 5, "turn-2")).toBe(false); // 4+5 = 9 < 10
      expect(store.getCounter("agent-1")).toBe(9);
      expect(store.get("agent-1", "turn-1")).toBeNull();
      store.close();
    });

    it("absorbs a delayed duplicate without erasing cadence accumulated by newer turns", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      // First crossing enqueues turn-1 and resets the counter to 0.
      expect(store.recordIteration("agent-1", 10, "turn-1")).toBe(true);
      expect(store.getCounter("agent-1")).toBe(0);
      // Accumulate below threshold with a *different* turn so the counter is
      // nonzero before the duplicate call (the real precondition the old test
      // never established).
      expect(store.recordIteration("agent-1", 6, "turn-2")).toBe(false);
      expect(store.getCounter("agent-1")).toBe(6);
      // A delayed duplicate for already-present turn-1 must be absorbed
      // without counting its iterations and without erasing turn-2's cadence.
      const again = store.recordIteration("agent-1", 4, "turn-1");
      expect(again).toBe(true);
      expect(store.getCounter("agent-1")).toBe(6);
      // Only the original turn-1 row exists; no second row was created.
      const rows = store.listAll();
      expect(rows.filter((r) => r.turnId === "turn-1")).toHaveLength(1);
      expect(rows.filter((r) => r.turnId === "turn-2")).toHaveLength(0);
      store.close();
    });

    it("does not re-count a duplicate turn that remained below threshold", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      expect(store.recordIteration("agent-1", 4, "turn-below")).toBe(false);
      expect(store.getCounter("agent-1")).toBe(4);

      expect(store.recordIteration("agent-1", 4, "turn-below")).toBe(false);
      expect(store.getCounter("agent-1")).toBe(4);
      expect(store.hasObservedTurn("agent-1", "turn-below")).toBe(true);
      store.close();
    });

    it("does not re-count an immediate duplicate below threshold (single reset / idempotency)", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      // First crossing enqueues turn-1 and resets the counter to 0.
      expect(store.recordIteration("agent-1", 10, "turn-1")).toBe(true);
      expect(store.getCounter("agent-1")).toBe(0);
      // An immediate duplicate event for the SAME already-present turn-1 with a
      // small iteration count (below threshold): it must be absorbed — return
      // true because the row is durably present, keep the counter at 0 (the
      // same turn is NOT re-counted), and create no second row.
      const again = store.recordIteration("agent-1", 1, "turn-1");
      expect(again).toBe(true);
      expect(store.getCounter("agent-1")).toBe(0);
      const rows = store.listAll();
      expect(rows.filter((r) => r.sourceAgentId === "agent-1" && r.turnId === "turn-1")).toHaveLength(1);
      store.close();
    });

    it("control: a different turn at the same total creates a second row and resets", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      // First crossing enqueues turn-1 and resets the counter to 0.
      expect(store.recordIteration("agent-1", 10, "turn-1")).toBe(true);
      expect(store.getCounter("agent-1")).toBe(0);
      // Accumulate below threshold with a different turn.
      expect(store.recordIteration("agent-1", 6, "turn-2")).toBe(false);
      expect(store.getCounter("agent-1")).toBe(6);
      // A *different* turn (turn-3) at the same total (6 + 4 = 10): this is
      // NOT a duplicate, so a second row is created and the counter is reset.
      expect(store.recordIteration("agent-1", 4, "turn-3")).toBe(true);
      expect(store.getCounter("agent-1")).toBe(0);
      // Two rows exist now (turn-1 and turn-3); turn-2 is gone.
      const rows = store.listAll();
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.turnId === "turn-1")).toBe(true);
      expect(rows.some((r) => r.turnId === "turn-3")).toBe(true);
      expect(rows.some((r) => r.turnId === "turn-2")).toBe(false);
      store.close();
    });

    it("honours a custom reviewThreshold via configuration", () => {
      const store = new CuratorStore(":memory:", { reviewThreshold: 3, maxRetries: 3 });
      expect(store.recordIteration("agent-1", 2, "turn-1")).toBe(false);
      expect(store.getCounter("agent-1")).toBe(2);
      expect(store.recordIteration("agent-1", 1, "turn-2")).toBe(true); // 3 == threshold
      expect(store.getCounter("agent-1")).toBe(0);
      store.close();
    });
  });

  describe("reconciliation and skill lifecycle state", () => {
    it("persists the reconciliation cursor across reopen", () => {
      const dbPath = `${process.env.TMPDIR ?? "/tmp"}/curator-cursor-${Date.now()}-${Math.random()}.sqlite`;
      const first = new CuratorStore(dbPath);
      first.setReconciliationCursor("cursor-42");
      first.close();

      const reopened = new CuratorStore(dbPath);
      expect(reopened.getReconciliationCursor()).toBe("cursor-42");
      reopened.close();
    });

    it("tracks curator-created skill activity and lifecycle state", () => {
      const clock = new FakeClock(Date.parse("2040-01-01T00:00:00.000Z"));
      const store = new CuratorStore(":memory:", clockConfig(clock, 60_000));
      store.recordSkillActivity("learned-skill", "paseo-curator", "create");
      clock.advance(1_000);
      store.recordSkillActivity("learned-skill", "paseo-curator", "patch");

      expect(store.listSkillTelemetry()).toEqual([expect.objectContaining({
        skillName: "learned-skill",
        createdBy: "paseo-curator",
        state: "active",
        patchCount: 1,
        lastActivityAt: "2040-01-01T00:00:01.000Z",
      })]);
      store.setSkillState("learned-skill", "stale");
      expect(store.listSkillTelemetry()[0]?.state).toBe("stale");
      store.close();
    });

    it("appends contract-valid content-free audit records", () => {
      const store = new CuratorStore(":memory:");
      store.recordAudit({
        queueId: "queue-1", sourceAgentId: "agent-1", turnId: "turn-1",
        outcome: "applied", summary: "batch applied", operationCount: 1,
        operationsHash: "a".repeat(64), skillNames: ["skill-a"],
      });
      store.recordAudit({
        queueId: "queue-2", sourceAgentId: "agent-1", turnId: "turn-2",
        outcome: "rejected", summary: "batch rejected", operationCount: 1,
        operationsHash: "b".repeat(64), skillNames: ["skill-a"],
        rejectionReason: "bounded rejection",
      });

      const rows = store.listAudit();
      expect(rows).toEqual([
        expect.objectContaining({ queueId: "queue-1", sourceAgentId: "agent-1", turnId: "turn-1", outcome: "applied", operationsHash: "a".repeat(64) }),
        expect.objectContaining({ queueId: "queue-2", sourceAgentId: "agent-1", turnId: "turn-2", outcome: "rejected", rejectionReason: "bounded rejection" }),
      ]);
      store.close();
    });
  });

  describe("state transitions", () => {
    it("moves pending -> running on claim and increments attempts", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      store.recordIteration("agent-1", 10);
      const claimed = store.claimNext();
      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe("running");
      expect(claimed?.attempts).toBe(1);
      expect(claimed?.startedAt).toBeDefined();
      const rec = store.get("agent-1", "turn-1");
      expect(rec?.status).toBe("running");
      expect(rec?.attempts).toBe(1);
      store.close();
    });

    it("uses the injected clock for claim timestamps", () => {
      const clock = new FakeClock(Date.parse("2040-05-06T07:08:09.000Z"));
      const store = new CuratorStore(":memory:", clockConfig(clock, 60_000));
      store.enqueue("agent-clock", "turn-clock");

      const claimed = store.claimNext();

      expect(claimed?.startedAt).toBe("2040-05-06T07:08:09.000Z");
      expect(claimed?.updatedAt).toBe("2040-05-06T07:08:09.000Z");
      store.close();
    });

    it("uses a claim generation fence so a stale worker cannot complete a recovered claim", () => {
      const clock = new FakeClock(Date.parse("2050-01-01T00:00:00.000Z"));
      const store = new CuratorStore(":memory:", clockConfig(clock, 1));
      const queued = store.enqueue("agent-fence", "turn-fence")!;
      const oldClaim = store.claimNext()!;
      expect(oldClaim.attempts).toBe(1);

      clock.advance(2);
      expect(store.recoverStaleRunning()).toEqual({ recoveredIds: [queued.id], failed: [] });
      const newClaim = store.claimNext()!;
      expect(newClaim.attempts).toBe(2);

      expect(store.complete(oldClaim.id, "applied", oldClaim.attempts)).toBe(false);
      expect(store.retryOrFail(oldClaim.id, "old worker", oldClaim.attempts)).toBe("stale");
      expect(store.get("agent-fence", "turn-fence")?.status).toBe("running");

      expect(store.complete(newClaim.id, "applied", newClaim.attempts)).toBe(true);
      expect(store.get("agent-fence", "turn-fence")?.status).toBe("applied");
      store.close();
    });

    it("moves running -> applied on completion and does not requeue on duplicate", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      store.recordIteration("agent-1", 10);
      const running = store.claimNext();
      store.complete(running!.id, "applied", running!.attempts);
      const rec = store.get("agent-1", "turn-1");
      expect(rec?.status).toBe("applied");
      expect(rec?.completedAt).toBeDefined();
      // Completing an already-applied row is a no-op (idempotent), not an error.
      expect(() => store.complete(running!.id, "applied", running!.attempts)).not.toThrow();
      expect(store.get("agent-1", "turn-1")?.status).toBe("applied");
      store.close();
    });

    it("moves running -> nothing_to_save and does not requeue on duplicate", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      store.recordIteration("agent-1", 10);
      const running = store.claimNext();
      store.complete(running!.id, "nothing_to_save", running!.attempts);
      const rec = store.get("agent-1", "turn-1");
      expect(rec?.status).toBe("nothing_to_save");
      expect(rec?.completedAt).toBeDefined();
      // never requeue: a duplicate complete of a terminal success is a no-op.
      expect(() => store.complete(running!.id, "nothing_to_save", running!.attempts)).not.toThrow();
      expect(store.get("agent-1", "turn-1")?.status).toBe("nothing_to_save");
      store.close();
    });

    it("never requeues applied or nothing_to_save rows on recovery", () => {
      const store = new CuratorStore(":memory:", { reviewThreshold: 10, maxRetries: 3 });
      // Two turns, both completed and applied / nothing_to_save.
      store.recordIteration("agent-1", 10, "turn-a");
      store.recordIteration("agent-1", 10, "turn-b");
      const a = store.claimNext()!;
      store.complete(a.id, "applied", a.attempts);
      const b = store.claimNext()!;
      store.complete(b.id, "nothing_to_save", b.attempts);
      // Recovery must not touch terminal rows.
      const recovered = store.recoverStaleRunning();
      expect(recovered).toEqual({ recoveredIds: [], failed: [] });
      expect(store.get("agent-1", "turn-a")?.status).toBe("applied");
      expect(store.get("agent-1", "turn-b")?.status).toBe("nothing_to_save");
      store.close();
    });

    it("does not transition a running row to a new running claim while already running", () => {
      const store = new CuratorStore(":memory:", baseConfig);
      store.recordIteration("agent-1", 10);
      const first = store.claimNext();
      // A second claim of the same already-running row is rejected (already claimed).
      const second = store.claim(first!.id);
      expect(second).toBeNull();
      expect(store.get("agent-1", "turn-1")?.attempts).toBe(1);
      store.close();
    });
  });

  describe("retry recovery of stale running rows", () => {
    const STALE_AFTER_MS = 5_000;

    it("recovers a running row that is stale and within the max retries", () => {
      const clock = new FakeClock(Date.now());
      const store = new CuratorStore(":memory:", clockConfig(clock, STALE_AFTER_MS));
      store.recordIteration("agent-1", 10);
      const running = store.claimNext()!;
      expect(running.status).toBe("running");
      // Advance the clock beyond the staleness window so the row is stale.
      clock.advance(STALE_AFTER_MS + 1);
      const recovered = store.recoverStaleRunning();
      expect(recovered).toEqual({ recoveredIds: [running.id], failed: [] });
      // Recovered rows are back to pending so a fresh claim can pick them up.
      expect(store.get("agent-1", "turn-1")?.status).toBe("pending");
      // attempts is preserved (not reset) so the retry budget is tracked.
      expect(store.get("agent-1", "turn-1")?.attempts).toBe(1);
      store.close();
    });

    it("does not recover a running row that is not yet stale", () => {
      const clock = new FakeClock(Date.now());
      const store = new CuratorStore(":memory:", clockConfig(clock, STALE_AFTER_MS));
      store.recordIteration("agent-1", 10);
      const running = store.claimNext()!;
      expect(running.status).toBe("running");
      // Advance the clock just short of the staleness window.
      clock.advance(STALE_AFTER_MS - 1);
      const recovered = store.recoverStaleRunning();
      expect(recovered).toEqual({ recoveredIds: [], failed: [] });
      // The row is still running (not stale, not recovered).
      expect(store.get("agent-1", "turn-1")?.status).toBe("running");
      expect(store.get("agent-1", "turn-1")?.attempts).toBe(1);
      store.close();
    });

    it("recovers a running row after process restart without any test-only call", () => {
      // Simulates a process restart: a new store instance on the same disk
      // database, with a clock that has advanced past the staleness window.
      const dbPath = `${process.env.TMPDIR ?? "/tmp"}/curator-restart-${Date.now()}-${Math.random()}.sqlite`;
      const clock = new FakeClock(Date.now());
      {
        const store = new CuratorStore(dbPath, clockConfig(clock, STALE_AFTER_MS));
        store.recordIteration("agent-1", 10);
        store.claimNext()!; // -> running, started_at stamped
        // Simulate crash: close the store (process exits) without completing.
        store.close();
      }
      // Advance the clock well past the staleness window (time has passed).
      clock.advance(STALE_AFTER_MS + 1000);
      {
        const store = new CuratorStore(dbPath, clockConfig(clock, STALE_AFTER_MS));
        // Recovery must detect the stale running row via started_at — no test hook.
        const recovered = store.recoverStaleRunning();
        expect(recovered.recoveredIds).toHaveLength(1);
        expect(recovered.failed).toEqual([]);
        // The row is back to pending and can be re-claimed.
        expect(store.get("agent-1", "turn-1")?.status).toBe("pending");
        expect(store.get("agent-1", "turn-1")?.attempts).toBe(1);
        // A fresh claim re-runs it; attempts increments to 2.
        const r = store.claimNext()!;
        expect(r.attempts).toBe(2);
        store.close();
      }
    });

    it("does not recover a running row whose attempts have reached the max retries", () => {
      const clock = new FakeClock(Date.now());
      const store = new CuratorStore(":memory:", { ...clockConfig(clock, STALE_AFTER_MS), maxRetries: 2 });
      store.recordIteration("agent-1", 10);
      // Cycle 1: claim (attempts 0->1), time passes (stale), recover (attempts 1 < 2 -> pending).
      let r = store.claimNext()!;
      expect(r.attempts).toBe(1);
      clock.advance(STALE_AFTER_MS + 1);
      store.recoverStaleRunning();
      expect(store.get("agent-1", "turn-1")?.status).toBe("pending");
      // Cycle 2: claim (attempts 1->2 == maxRetries), time passes (stale again).
      r = store.claimNext()!;
      expect(r.attempts).toBe(2);
      clock.advance(STALE_AFTER_MS + 1);
      // Recovery: attempts == maxRetries -> terminal failed, NOT re-queued.
      const recovered = store.recoverStaleRunning();
      expect(recovered).toEqual({
        recoveredIds: [],
        failed: [{ sourceAgentId: "agent-1", turnId: "turn-1" }],
      });
      const rec = store.get("agent-1", "turn-1");
      expect(rec?.status).toBe("failed");
      expect(rec?.error).toBe("exceeded maxRetries");
      store.close();
    });

    it("retryOrFail requeues a running row while attempts is below the max, and the row can be claimed again", () => {
      const store = new CuratorStore(":memory:", { reviewThreshold: 10, maxRetries: 3 });
      store.recordIteration("agent-1", 10);
      // Cycle 1: claim (attempts 0 -> 1), then retryOrFail requeues it.
      let r = store.claimNext()!;
      expect(r.attempts).toBe(1);
      expect(store.retryOrFail(r.id, "curator failed for agent \"agent-1\" turn \"turn-1\": Error", r.attempts)).toBe("pending");
      const rec = store.get("agent-1", "turn-1");
      expect(rec?.status).toBe("pending");
      // A requeued row keeps its attempt count; startedAt is cleared so the
      // row is claimable and stale-recovery can find it later.
      expect(rec?.attempts).toBe(1);
      expect(rec?.startedAt).toBeUndefined();
      expect(rec?.error).toBeUndefined();
      // The requeued row is claimable again.
      r = store.claimNext()!;
      expect(r.attempts).toBe(2);

      // Cycle 2: one more requeue.
      expect(store.retryOrFail(r.id, "curator failed for agent \"agent-1\" turn \"turn-1\": Error", r.attempts)).toBe("pending");
      expect(store.get("agent-1", "turn-1")?.status).toBe("pending");
      r = store.claimNext()!;
      expect(r.attempts).toBe(3);

      // Cycle 3: attempts (3) has reached maxRetries (3): terminal failure.
      expect(store.retryOrFail(r.id, "curator failed for agent \"agent-1\" turn \"turn-1\": Error", r.attempts)).toBe("failed");
      const failed = store.get("agent-1", "turn-1");
      expect(failed?.status).toBe("failed");
      expect(failed?.attempts).toBe(3);
      expect(failed?.error).toBe("curator failed for agent \"agent-1\" turn \"turn-1\": Error");
      expect(failed?.completedAt).toBeDefined();
      // Terminal: no further requeue and no further claim.
      expect(store.retryOrFail(failed!.id, "again", failed!.attempts)).toBe("unchanged");
      expect(store.claimNext()).toBeNull();
      store.close();
    });

    it("retryOrFail leaves applied and nothing_to_save rows unchanged", () => {
      const store = new CuratorStore(":memory:", { reviewThreshold: 10, maxRetries: 3 });
      store.recordIteration("agent-1", 10, "turn-a");
      store.recordIteration("agent-1", 10, "turn-b");
      const a = store.claimNext()!;
      store.complete(a.id, "applied", a.attempts);
      const b = store.claimNext()!;
      store.complete(b.id, "nothing_to_save", b.attempts);

      expect(store.retryOrFail(a.id, "boom", a.attempts)).toBe("unchanged");
      expect(store.retryOrFail(b.id, "boom", b.attempts)).toBe("unchanged");

      const ra = store.get("agent-1", "turn-a");
      const rb = store.get("agent-1", "turn-b");
      expect(ra?.status).toBe("applied");
      expect(ra?.error).toBeUndefined();
      expect(ra?.attempts).toBe(1);
      expect(rb?.status).toBe("nothing_to_save");
      expect(rb?.error).toBeUndefined();
      expect(rb?.attempts).toBe(1);
      store.close();
    });

    it("marks a row failed with an error message when it is failed explicitly", () => {
      const store = new CuratorStore(":memory:", { reviewThreshold: 10, maxRetries: 3 });
      store.recordIteration("agent-1", 10);
      const running = store.claimNext()!;
      store.fail(running.id, "permanent failure", running.attempts);
      const rec = store.get("agent-1", "turn-1");
      expect(rec?.status).toBe("failed");
      expect(rec?.error).toBe("permanent failure");
      // QueueRecord schema: error is only allowed on failed rows.
      expect(() => QueueRecordSchema.parse(rec!)).not.toThrow();
      store.close();
    });
  });
});
