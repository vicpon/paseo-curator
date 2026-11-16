import { describe, expect, it } from "vitest";

import { CuratorStore, type StoreConfig } from "../server/store";
import type { SourceAgent, WholeTurnRead, CuratorRunResult } from "../server/paseo-adapter";
import type { SkillOperation } from "../server/contracts";
import { sha256 } from "../server/skill-files";
import {
  CuratorOrchestrator,
  type CuratorActivityNotification,
} from "../server/orchestrator";

// ---------------------------------------------------------------------------
// Fixture literals (hand-derived, parser-compatible, with readSet)
// ---------------------------------------------------------------------------

const SKILL_MD =
  "---\nname: git-hygiene\ndescription: Commit and branch conventions.\n---\n\n## Rules\n\n- Conventional commits.\n";

/** SHA-256 of the exact SKILL_MD content above. */
const SKILL_MD_HASH = sha256(SKILL_MD);

/** A valid "saved" review document: one patch + one readSet entry. */
const SAVED_DOC = {
  summary: "Learned a reusable debugging workflow.",
  outcome: "saved" as const,
  operations: [
    {
      type: "patch" as const,
      skillName: "git-hygiene",
      path: "SKILL.md",
      oldText: "## Rules",
      newText: "## Rules (v2)",
    },
  ],
  readSet: [{ skillName: "git-hygiene", path: "SKILL.md", content: SKILL_MD, hash: SKILL_MD_HASH }],
};

/** Raw curator output: exactly one plain JSON object. */
const SAVED_FINAL_TEXT = JSON.stringify(SAVED_DOC);

/** A valid "nothing_to_save" document: empty operations and readSet. */
const NOTHING_DOC = {
  summary: "Nothing reusable in this turn.",
  outcome: "nothing_to_save" as const,
  operations: [] as SkillOperation[],
  readSet: [] as unknown[],
};

/** Raw curator output for the nothing_to_save case. */
const NOTHING_FINAL_TEXT = JSON.stringify(NOTHING_DOC);

// ---------------------------------------------------------------------------
// Typed fakes
// ---------------------------------------------------------------------------

/** A minimal, deterministic turn read. */
function makeRead(
  agentId: string,
  turnId: string,
  entries: WholeTurnRead["entries"],
  toolIterations: number,
): WholeTurnRead {
  return {
    sourceAgentId: agentId,
    turnId,
    provider: "test-provider",
    cwd: "/tmp/curator-work",
    entries,
    toolIterations,
    usedSkillNames: [],
  };
}

/**
 * A typed adapter fake. Tests configure the exact turn(s) the orchestrator
 * will read (keyed by `${agentId}:${turnId}`) and the final text(s) the
 * curator will produce (same key). Every invocation is recorded for
 * assertion.
 */
class FakeAdapter {
  /**
   * When set, `readWholeTurn` awaits the gate before resolving — a
   * deterministic suspension point for the shutdown tests (no timers).
   */
  readGate: Gate | null = null;
  private reads = new Map<string, WholeTurnRead>();
  private texts = new Map<string, string>();
  /**
   * Sequential overrides: when a key has an entry here, `readWholeTurn`
   * pops (and returns) the next value in sequence instead of the static
   * value, until the sequence is exhausted (then it falls through to the
   * static map). This lets a test script the same turn to fail the first N
   * reads and succeed afterwards, or to emit different curator outputs
   * across retries.
   */
  private readSeqs = new Map<string, WholeTurnRead[]>();
  private textSeqs = new Map<string, string[]>();
  readWholeTurnCalls: Array<{ agent: SourceAgent; turnId: string }> = [];
  runCuratorCalls: Array<{ agent: SourceAgent; turnId: string; prompt: string }> = [];

  private key(agentId: string, turnId: string): string {
    return `${agentId}:${turnId}`;
  }

  addRead(agentId: string, turnId: string, read: WholeTurnRead): void {
    this.reads.set(this.key(agentId, turnId), read);
  }

  setFinalText(agentId: string, turnId: string, text: string): void {
    this.texts.set(this.key(agentId, turnId), text);
  }

  /** Replace the static read with a sequence served one call at a time. */
  setReadSequence(agentId: string, turnId: string, ...reads: WholeTurnRead[]): void {
    this.readSeqs.set(this.key(agentId, turnId), [...reads]);
  }

  /** Replace the static final text with a sequence served one call at a time. */
  setTextSequence(agentId: string, turnId: string, ...texts: string[]): void {
    this.textSeqs.set(this.key(agentId, turnId), [...texts]);
  }

  /** Make `readWholeTurn` throw for every call on this turn (after any scripted sequence is exhausted). */
  setReadThrow(agentId: string, turnId: string, error: Error): void {
    this.readThrew.set(this.key(agentId, turnId), error);
  }

  /** Make `runCurator` throw for every call on this turn (after any scripted sequence is exhausted). */
  setCuratorThrow(agentId: string, turnId: string, error: Error): void {
    this.curatorThrew.set(this.key(agentId, turnId), error);
  }

  private readThrew = new Map<string, Error>();
  private curatorThrew = new Map<string, Error>();

  async readWholeTurn(agent: SourceAgent, turnId: string): Promise<WholeTurnRead> {
    this.readWholeTurnCalls.push({ agent, turnId });
    if (this.readGate !== null) {
      await this.readGate.promise;
    }
    const k = this.key(agent.id, turnId);
    const seq = this.readSeqs.get(k);
    if (seq !== undefined && seq.length > 1) {
      const read = seq.shift()!;
      if (seq.length === 0) {
        this.readSeqs.delete(k);
      }
      return read;
    }
    const read = this.reads.get(k);
    if (!read) {
      const err = this.readThrew.get(k);
      if (err) throw err;
      throw new Error(`fake adapter: no read configured for ${agent.id} / ${turnId}`);
    }
    return read;
  }

  async runCurator(agent: SourceAgent, turnId: string, prompt: string): Promise<CuratorRunResult> {
    this.runCuratorCalls.push({ agent, turnId, prompt });
    const k = this.key(agent.id, turnId);
    const seq = this.textSeqs.get(k);
    if (seq !== undefined && seq.length > 1) {
      const text = seq.shift()!;
      if (seq.length === 0) {
        this.textSeqs.delete(k);
      }
      return { curatorAgentId: `curator-${agent.id}-${turnId}`, finalText: text };
    }
    const text = this.texts.get(k);
    if (text === undefined) {
      const err = this.curatorThrew.get(k);
      if (err) throw err;
      throw new Error(`fake adapter: no final text configured for ${agent.id} / ${turnId}`);
    }
    return { curatorAgentId: `curator-${agent.id}-${turnId}`, finalText: text };
  }
}

type ManagerOutcome = "applied" | "rejected" | "rolled_back" | "rollback_failed";

/** A typed skill-manager fake that records every applyBatch invocation. */
class FakeManager {
  reconcileResult: "none" | "applied" | "reconciliation_required" = "none";
  reconcileCalls: Array<{ queueId: string; sourceAgentId: string; turnId: string }> = [];
  calls: Array<{
    operations: SkillOperation[];
    readSet: Array<{ skillName: string; path: string; content: string; hash: string }>;
    context: {
      queueId: string;
      sourceAgentId: string;
      turnId: string;
      claimIsCurrent?: () => boolean;
    };
  }> = [];

  /**
   * Sequential scripted results served one per `applyBatch` call for a given
   * turn (keyed by `${agentId}:${turnId}`), until exhausted (then it falls
   * through to the default "applied"). Lets a test script, e.g., "rejected,
   * rejected, applied", or throw on every call to prove the retry cap is
   * reached on adapter/manager failures.
   */
  private scriptSeqs = new Map<string, ScriptedManager[]>();

  setScript(
    agentId: string,
    turnId: string,
    ...scripts: ManagerOutcome[]
  ): void {
    this.scriptSeqs.set(
      `${agentId}:${turnId}`,
      scripts.map((s) => ({ kind: "outcome" as const, outcome: s })),
    );
  }

  setThrown(
    agentId: string,
    turnId: string,
    ...errors: Array<Error | ((callIndex: number) => Error)>
  ): void {
    this.scriptSeqs.set(
      `${agentId}:${turnId}`,
      errors.map((e) => ({ kind: "throw" as const, error: e })),
    );
  }

  async reconcileBatch(
    context: { queueId: string; sourceAgentId: string; turnId: string },
  ): Promise<
    | { outcome: "none" }
    | { outcome: "applied"; operationsHash: string; operationCount: number; skillNames: string[] }
    | { outcome: "reconciliation_required"; operationsHash?: string; operationCount?: number; skillNames?: string[] }
  > {
    this.reconcileCalls.push(context);
    if (this.reconcileResult === "applied") {
      return { outcome: "applied", operationsHash: "a".repeat(64), operationCount: 2, skillNames: ["skill-a", "skill-b"] };
    }
    return { outcome: this.reconcileResult };
  }

  async applyBatch(
    operations: SkillOperation[],
    readSet: Array<{ skillName: string; path: string; content: string; hash: string }>,
    context: { queueId: string; sourceAgentId: string; turnId: string },
  ): Promise<{ outcome: ManagerOutcome }> {
    this.calls.push({ operations, readSet, context });
    const k = `${context.sourceAgentId}:${context.turnId}`;
    const callIndex = this.calls.length - 1;
    const seq = this.scriptSeqs.get(k);
    if (seq !== undefined && seq.length > 0) {
      const scripted = seq.shift() ?? { kind: "outcome" as const, outcome: "applied" as ManagerOutcome };
      if (seq.length === 0) {
        this.scriptSeqs.delete(k);
      }
      if (scripted.kind === "throw") {
        throw typeof scripted.error === "function" ? scripted.error(callIndex) : scripted.error;
      }
      return { outcome: scripted.outcome };
    }
    return { outcome: "applied" };
  }
}

type ManagerApplyResult = Awaited<ReturnType<FakeManager["applyBatch"]>>;
/** What a scripted `applyBatch` does: return an outcome, or throw an error. */
type ScriptedManager =
  | { kind: "outcome"; outcome: ManagerOutcome }
  | { kind: "throw"; error: Error | ((callIndex: number) => Error) };

/** A captured scheduler: records every task it is handed. */
class CapturedScheduler {
  calls: unknown[] = [];
  schedule(task: unknown): void {
    this.calls.push(task);
  }
}

/**
 * A deterministic deferred gate. Tests resolve (or reject) it exactly once;
 * an `await gate` promise suspends the caller until then. No timers or
 * sleeps are involved.
 */
class Gate {
  private resolveFn: (() => void) | null = null;
  private rejectFn: ((err: Error) => void) | null = null;
  readonly promise: Promise<void> = new Promise<void>((resolve, reject) => {
    this.resolveFn = resolve;
    this.rejectFn = reject;
  });
  resolve(): void {
    this.resolveFn?.();
    this.resolveFn = null;
    this.rejectFn = null;
  }
  reject(err: Error): void {
    this.rejectFn?.(err);
    this.resolveFn = null;
    this.rejectFn = null;
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function makeAgent(id: string): SourceAgent {
  return { id, provider: "test-provider", cwd: "/tmp/curator-work" };
}

interface Env {
  store: CuratorStore;
  adapter: FakeAdapter;
  manager: FakeManager;
  scheduler: CapturedScheduler;
  notifications: CuratorActivityNotification[];
  orch: CuratorOrchestrator;
}

function setup(storeConfig: Partial<StoreConfig> = {}): Env {
  const store = new CuratorStore(":memory:", {
    reviewThreshold: 10,
    maxRetries: 3,
    ...storeConfig,
  });
  const adapter = new FakeAdapter();
  const manager = new FakeManager();
  const scheduler = new CapturedScheduler();
  const notifications: CuratorActivityNotification[] = [];
  const orch = new CuratorOrchestrator({
    store,
    adapter,
    skillManager: manager,
    listSkills: async () => [],
    schedule: (t: unknown) => scheduler.schedule(t),
    notify: async (notification) => {
      notifications.push(notification);
    },
  });
  return { store, adapter, manager, scheduler, notifications, orch };
}

function teardown(env: Env): void {
  env.store.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CuratorOrchestrator", () => {
  it("reconciles a committed batch before rerunning the curator", async () => {
    const env = setup();
    try {
      env.store.recordIteration("agent-reconcile", 10, "turn-reconcile");
      env.manager.reconcileResult = "applied";

      await env.orch.processPending();

      expect(env.adapter.readWholeTurnCalls).toHaveLength(0);
      expect(env.adapter.runCuratorCalls).toHaveLength(0);
      expect(env.manager.calls).toHaveLength(0);
      expect(env.store.get("agent-reconcile", "turn-reconcile")?.status).toBe("applied");
      expect(env.store.listAudit()).toEqual([
        expect.objectContaining({
          sourceAgentId: "agent-reconcile",
          turnId: "turn-reconcile",
          outcome: "applied",
          operationsHash: "a".repeat(64),
          operationCount: 2,
          skillNames: ["skill-a", "skill-b"],
        }),
      ]);
    } finally {
      teardown(env);
    }
  });

  it("terminal-fails an ambiguous journal without rerunning the curator", async () => {
    const env = setup();
    try {
      env.store.recordIteration("agent-ambiguous", 10, "turn-ambiguous");
      env.manager.reconcileResult = "reconciliation_required";

      await env.orch.processPending();

      expect(env.adapter.readWholeTurnCalls).toHaveLength(0);
      expect(env.manager.calls).toHaveLength(0);
      const row = env.store.get("agent-ambiguous", "turn-ambiguous");
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe("filesystem reconciliation required");
      expect(env.store.listAudit()).toEqual([
        expect.objectContaining({
          sourceAgentId: "agent-ambiguous",
          turnId: "turn-ambiguous",
          outcome: "rejected",
          rejectionReason: "filesystem reconciliation required",
        }),
      ]);
    } finally {
      teardown(env);
    }
  });

  it(
    "accumulates below-threshold turns without queuing or scheduling",
    async () => {
      const env = setup();
      try {
        const agent = makeAgent("agent-A");
        env.adapter.addRead(
          "agent-A",
          "turn-1",
          {
            ...makeRead("agent-A", "turn-1", [{ role: "user", content: "do something" }], 7),
            usedSkillNames: ["tdd"],
          },
        );

        const result = await env.orch.handleCompletedTurn(agent, "turn-1");

        // The counter accumulated the turn's iterations.
        expect(result.toolIterations).toBe(7);
        expect(env.store.getCounter("agent-A")).toBe(7);
        // No row was created.
        expect(env.store.get("agent-A", "turn-1")).toBeNull();
        // Nothing was scheduled.
        expect(result.enqueued).toBe(false);
        expect(env.scheduler.calls).toHaveLength(0);
        expect(env.manager.calls).toHaveLength(0);
        expect(env.store.listSkillTelemetry()).toEqual([
          expect.objectContaining({ skillName: "tdd", useCount: 1 }),
        ]);
      } finally {
        teardown(env);
      }
    },
  );

  it(
    "durably enqueues on threshold crossing, then schedules",
    async () => {
      const env = setup();
      try {
        const agent = makeAgent("agent-B");
        // Seed the counter to 9 so one iteration crosses the threshold of 10.
        env.store.recordIteration("agent-B", 9, "seed-turn");

        env.adapter.addRead(
          "agent-B",
          "turn-2",
          makeRead("agent-B", "turn-2", [{ role: "user", content: "another request" }], 1),
        );

        const result = await env.orch.handleCompletedTurn(agent, "turn-2");

        expect(result.enqueued).toBe(true);
        expect(result.toolIterations).toBe(1);

        // One pending row exists for the turn.
        const row = env.store.get("agent-B", "turn-2");
        expect(row).not.toBeNull();
        expect(row!.status).toBe("pending");
        expect(row!.sourceAgentId).toBe("agent-B");
        expect(row!.turnId).toBe("turn-2");

        // The counter was reset after the enqueue.
        expect(env.store.getCounter("agent-B")).toBe(0);

        // The scheduler was called exactly once, for this turn.
        expect(env.scheduler.calls).toHaveLength(1);
      } finally {
        teardown(env);
      }
    },
  );

  it(
    "duplicate completed events yield one queue row and one curator execution",
    async () => {
      const env = setup();
      try {
        const agent = makeAgent("agent-C");
        // Seed to 9 so the turn crosses the threshold.
        env.store.recordIteration("agent-C", 9, "seed-turn");
        env.adapter.addRead(
          "agent-C",
          "turn-1",
          makeRead("agent-C", "turn-1", [{ role: "user", content: "fix bug" }], 1),
        );
        env.adapter.setFinalText("agent-C", "turn-1", SAVED_FINAL_TEXT);

        // Simulate the hook double-firing for the same turn: two concurrent
        // completed events for the exact same source turn.
        const [r1, r2] = await Promise.all([
          env.orch.handleCompletedTurn(agent, "turn-1"),
          env.orch.handleCompletedTurn(agent, "turn-1"),
        ]);

        // Both events see the crossing (a duplicate row is durably present, so
        // the cadence records the turn as consumed by the existing row).
        expect(r1.enqueued).toBe(true);
        expect(r2.enqueued).toBe(true);

        // Exactly one row exists for the turn.
        const rows = env.store
          .listAll()
          .filter((r) => r.sourceAgentId === "agent-C" && r.turnId === "turn-1");
        expect(rows).toHaveLength(1);

        // Drain the queue: exactly one curator run for the turn.
        await env.orch.processPending();
        expect(
          env.adapter.runCuratorCalls.filter((c) => c.agent.id === "agent-C" && c.turnId === "turn-1"),
        ).toHaveLength(1);
      } finally {
        teardown(env);
      }
    },
  );

  it(
    "processing reads the exact turn, builds the prompt, runs the curator, parses output, applies to skillManager, and marks the row applied",
    async () => {
      const env = setup();
      try {
        const agent = makeAgent("agent-D");
        const turnId = "turn-4";

        env.adapter.addRead(
          "agent-D",
          turnId,
          makeRead(
            "agent-D",
            turnId,
            [
              { role: "user", content: "Refactor the auth module" },
              { role: "assistant", content: "I extracted the token validation into a pure function." },
            ],
            12,
          ),
        );
        env.adapter.setFinalText("agent-D", turnId, SAVED_FINAL_TEXT);

        // Manually enqueue the row (simulating a prior threshold crossing).
        const row = env.store.enqueue("agent-D", turnId);
        expect(row).not.toBeNull();

        await env.orch.processPending();

        // The curator was run with a prompt carrying the turn's exact identity,
        // transcript, and the (empty) skill index.
        expect(env.adapter.runCuratorCalls).toHaveLength(1);
        const prompt = env.adapter.runCuratorCalls[0].prompt;
        expect(prompt).toContain("agent-D");
        expect(prompt).toContain(turnId);
        expect(prompt).toContain("Refactor the auth module");
        expect(prompt).toContain("I extracted the token validation into a pure function.");
        expect(prompt).toContain("(no existing skills)");

        // The parsed operations and readSet were passed to skillManager with
        // the row's context.
        expect(env.manager.calls).toHaveLength(1);
        const mc = env.manager.calls[0];
        expect(mc.operations).toHaveLength(1);
        expect(mc.operations[0].type).toBe("patch");
        expect(mc.operations[0].skillName).toBe("git-hygiene");
        expect(mc.readSet).toHaveLength(1);
        expect(mc.readSet[0].skillName).toBe("git-hygiene");
        expect(mc.readSet[0].path).toBe("SKILL.md");
        expect(mc.readSet[0].content).toBe(SKILL_MD);
        expect(mc.readSet[0].hash).toBe(SKILL_MD_HASH);
        expect(mc.context).toEqual(expect.objectContaining({
          queueId: row!.id,
          sourceAgentId: "agent-D",
          turnId: "turn-4",
        }));
        expect(mc.context.claimIsCurrent?.()).toBe(false);

        // The row is now applied.
        expect(env.store.get("agent-D", turnId)!.status).toBe("applied");
        expect(env.store.listSkillTelemetry()).toEqual([expect.objectContaining({
          skillName: "git-hygiene",
          createdBy: "unknown",
          patchCount: 1,
          state: "active",
        })]);
        expect(env.notifications).toEqual([
          {
            outcome: "applied",
            sourceAgentId: "agent-D",
            turnId: "turn-4",
            operationCount: 1,
            skillNames: ["git-hygiene"],
          },
        ]);
      } finally {
        teardown(env);
      }
    },
  );

  it(
    "a valid nothing_to_save result skips skillManager and marks the row nothing_to_save",
    async () => {
      const env = setup();
      try {
        const agent = makeAgent("agent-E");
        const turnId = "turn-5";

        env.adapter.addRead(
          "agent-E",
          turnId,
          makeRead(
            "agent-E",
            turnId,
            [
              { role: "user", content: "What is the weather?" },
              { role: "assistant", content: "I do not have access to weather data." },
            ],
            10,
          ),
        );
        env.adapter.setFinalText("agent-E", turnId, NOTHING_FINAL_TEXT);

        const row = env.store.enqueue("agent-E", turnId);
        expect(row).not.toBeNull();

        await env.orch.processPending();

        // skillManager was never called: there is nothing to apply.
        expect(env.manager.calls).toHaveLength(0);

        // The curator was run (the verdict came from it) and the row is
        // terminal as nothing_to_save.
        expect(
          env.adapter.runCuratorCalls.filter((c) => c.agent.id === "agent-E" && c.turnId === turnId),
        ).toHaveLength(1);
        expect(env.store.get("agent-E", turnId)!.status).toBe("nothing_to_save");
        expect(env.notifications).toEqual([]);
      } finally {
        teardown(env);
      }
    },
  );

  it(
    "processPending drains pending rows one at a time and in FIFO order, even when called concurrently",
    async () => {
      const env = setup();
      try {
        const agent = makeAgent("agent-F");
        const turnIds = ["turn-a", "turn-b", "turn-c"];

        // Three pending rows, enqueued in this (FIFO) order.
        for (const tid of turnIds) {
          env.store.enqueue("agent-F", tid);
        }

        // Configure a read and a final text for each turn.
        for (const tid of turnIds) {
          env.adapter.addRead(
            "agent-F",
            tid,
            makeRead("agent-F", tid, [{ role: "user", content: `work ${tid}` }], 10),
          );
          env.adapter.setFinalText("agent-F", tid, SAVED_FINAL_TEXT);
        }

        // Call processPending three times concurrently: the orchestrator must
        // serialize the drain (one row at a time) and process all three.
        await Promise.all([env.orch.processPending(), env.orch.processPending(), env.orch.processPending()]);

        // All three rows are terminal and applied.
        const all = env.store.listAll().filter((r) => r.sourceAgentId === "agent-F");
        expect(all).toHaveLength(3);
        for (const r of all) {
          expect(r.status).toBe("applied");
        }

        // Each turn was read exactly once, in FIFO order.
        const readOrder = env.adapter.readWholeTurnCalls
          .filter((c) => c.agent.id === "agent-F")
          .map((c) => c.turnId);
        expect(readOrder).toEqual(["turn-a", "turn-b", "turn-c"]);

        // Each turn was curated exactly once, in FIFO order.
        const curOrder = env.adapter.runCuratorCalls
          .filter((c) => c.agent.id === "agent-F")
          .map((c) => c.turnId);
        expect(curOrder).toEqual(["turn-a", "turn-b", "turn-c"]);

        // skillManager was called once per turn.
        expect(env.manager.calls).toHaveLength(3);
      } finally {
        teardown(env);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Source metadata during queued processing
  // -------------------------------------------------------------------------

  it(
    "runs the curator with a SourceAgent rebuilt from the re-read turn's provider/cwd, never the empty placeholders",
    async () => {
      const env = setup();
      try {
        const agentId = "agent-meta";
        const turnId = "turn-meta";

        // The re-read supplies real provider/cwd metadata (what the adapter
        // now recovers from the timeline payload's agent snapshot).
        const read: WholeTurnRead = {
          sourceAgentId: agentId,
          turnId,
          provider: "re-read-provider",
          cwd: "/re-read/actual-cwd",
          entries: [{ role: "user", content: "do a thing" }],
          toolIterations: 10,
          usedSkillNames: [],
        };
        env.adapter.addRead(agentId, turnId, read);
        env.adapter.setFinalText(agentId, turnId, SAVED_FINAL_TEXT);

        const row = env.store.enqueue(agentId, turnId);
        expect(row).not.toBeNull();

        await env.orch.processPending();

        // The curator must run exactly once, with the source metadata of the
        // re-read — not the empty-string placeholders the queue row alone
        // implies.
        expect(env.adapter.runCuratorCalls.filter((c) => c.turnId === turnId)).toHaveLength(1);
        const call = env.adapter.runCuratorCalls[0];
        expect(call).toBeDefined();
        expect(call!.agent.id).toBe(agentId);
        expect(call!.agent.provider).toBe("re-read-provider");
        expect(call!.agent.cwd).toBe("/re-read/actual-cwd");
        expect(call!.agent.provider).not.toBe("");
        expect(call!.agent.cwd).not.toBe("");
      } finally {
        teardown(env);
      }
    },
  );

  // -------------------------------------------------------------------------
  // start(): lifecycle recovery at boot
  // -------------------------------------------------------------------------

  it(
    "start() recovers a stale running row and drains it to a terminal state with no new hook event",
    async () => {
      const env = setup({
        now: () => new Date("2100-01-01T00:00:00.000Z"),
        staleAfterMs: 0,
      });
      try {
        const agentId = "agent-stale";
        const turnId = "turn-stale";

        // Seed a real row and drive it to `running` with one attempt.
        const row = env.store.enqueue(agentId, turnId);
        expect(row).not.toBeNull();
        const claimed = env.store.claimNext();
        expect(claimed).not.toBeNull();
        expect(claimed!.id).toBe(row!.id);
        expect(claimed!.status).toBe("running");
        expect(claimed!.attempts).toBe(1);

        // Configure the (re-)read and a terminal curator verdict.
        env.adapter.addRead(
          agentId,
          turnId,
          makeRead(agentId, turnId, [{ role: "user", content: "do a thing" }], 10),
        );
        env.adapter.setFinalText(agentId, turnId, SAVED_FINAL_TEXT);

        // Wished lifecycle: start recovers the stale row, then drains the
        // recovered pending work. (RED: CuratorOrchestrator has no `start`
        // yet — the wished start(): Promise<void> calls
        // store.recoverStaleRunning() then drains the recovered rows.)
        const start = (env.orch as unknown as { start?: () => Promise<void> }).start;
        expect(start).toBeDefined();
        await start!.call(env.orch);

        // The row was recovered (pending) and then processed to a terminal
        // state, without any handleCompletedTurn / hook event.
        const rec = env.store.get(agentId, turnId);
        expect(rec?.status).toBe("applied");
        expect(env.adapter.runCuratorCalls.filter((c) => c.turnId === turnId)).toHaveLength(1);
      } finally {
        teardown(env);
      }
    },
  );

  it("start() surfaces a stale running row that recovery terminal-fails", async () => {
    let now = Date.parse("2100-01-01T00:00:00.000Z");
    const env = setup({
      now: () => new Date(now),
      staleAfterMs: 0,
      maxRetries: 1,
    });
    try {
      env.store.enqueue("agent-recovery-failed", "turn-recovery-failed");
      expect(env.store.claimNext()?.attempts).toBe(1);
      now += 1;

      await env.orch.start();

      expect(env.store.get("agent-recovery-failed", "turn-recovery-failed")?.status).toBe("failed");
      expect(env.notifications).toEqual([
        {
          outcome: "failed",
          sourceAgentId: "agent-recovery-failed",
          turnId: "turn-recovery-failed",
        },
      ]);
    } finally {
      teardown(env);
    }
  });

  it("does not notify when a fenced applied transition loses its claim", async () => {
    const env = setup();
    try {
      const agentId = "agent-stale-applied";
      const turnId = "turn-stale-applied";
      env.adapter.addRead(
        agentId,
        turnId,
        makeRead(agentId, turnId, [{ role: "user", content: "extract workflow" }], 10),
      );
      env.adapter.setFinalText(agentId, turnId, SAVED_FINAL_TEXT);
      env.store.enqueue(agentId, turnId);
      env.store.complete = () => false;

      await env.orch.processPending();

      expect(env.notifications).toEqual([]);
    } finally {
      teardown(env);
    }
  });

  // -------------------------------------------------------------------------
  // shutdown(): waits for the active run, then blocks later scheduling
  // -------------------------------------------------------------------------

  it(
    "shutdown() waits for the already-active delayed drain, then prevents any later hook from scheduling a new drain",
    async () => {
      const env = setup();
      try {
        const agentId = "agent-shutdown";
        const turnId = "turn-shutdown";

        // One pending row whose drain will hang in the (re-)read until a
        // deterministic gate is released.
        env.adapter.addRead(
          agentId,
          turnId,
          makeRead(agentId, turnId, [{ role: "user", content: "do a thing" }], 10),
        );
        env.adapter.setFinalText(agentId, turnId, SAVED_FINAL_TEXT);
        env.store.enqueue(agentId, turnId);

        // Start the drain but gate it inside readWholeTurn: the drain is
        // active and still suspended.
        const gate = new Gate();
        env.adapter.readGate = gate;
        const drain = env.orch.processPending();
        await Promise.resolve(); // let the drain reach the gated read

        // Shutdown must wait for the active drain to settle…
        const shuttingDown = env.orch.shutdown();
        // …and must not resolve before the drain does.
        let settled = false;
        void shuttingDown.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        // Release the drain.
        gate.resolve();
        await shuttingDown;

        // The gated row completed its review.
        expect(env.store.get(agentId, turnId)!.status).toBe("applied");

        // After shutdown, a later completed-turn event must not schedule a new
        // drain: no new scheduler call, and the row is untouched.
        env.adapter.addRead(
          agentId,
          "turn-after-shutdown",
          makeRead(agentId, "turn-after-shutdown", [{ role: "user", content: "later" }], 7),
        );
        const schedulerCallsBefore = env.scheduler.calls.length;
        const result = await env.orch.handleCompletedTurn(
          { id: agentId, provider: "", cwd: "" },
          "turn-after-shutdown",
        );
        expect(env.scheduler.calls.length).toBe(schedulerCallsBefore);
        expect(env.manager.calls.length).toBe(1);
        expect(env.store.get(agentId, "turn-after-shutdown")).toBeNull();
        void result;
      } finally {
        env.adapter.readGate = null;
        teardown(env);
      }
    },
  );

  it("shutdown() waits for an accepted completed-turn handler before resolving", async () => {
    const env = setup();
    try {
      const agentId = "agent-fast-path";
      const turnId = "turn-fast-path";
      env.adapter.addRead(
        agentId,
        turnId,
        makeRead(agentId, turnId, [{ role: "user", content: "accepted" }], 4),
      );
      const gate = new Gate();
      env.adapter.readGate = gate;

      const handling = env.orch.handleCompletedTurn(
        { id: agentId, provider: "provider/example-model", cwd: "/workspace" },
        turnId,
      );
      await Promise.resolve();
      const shuttingDown = env.orch.shutdown();
      let settled = false;
      void shuttingDown.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      gate.resolve();
      await Promise.all([handling, shuttingDown]);
      expect(env.store.getCounter(agentId)).toBe(4);
    } finally {
      env.adapter.readGate = null;
      teardown(env);
    }
  });

  // -------------------------------------------------------------------------
  // Retry / error-path behavior (RED: the wished retry behavior does not yet
  // exist; these tests define the contract)
  // -------------------------------------------------------------------------

  describe("retry and error paths", () => {
    const SENTINEL = "SENTINEL-SECRET-DO-NOT-LEAK";

    it("malformed curator output with a sentinel secret is attempted exactly maxRetries, ends failed with attempts=3, and the persisted error excludes the sentinel", async () => {
      const env = setup();
      try {
        const agentId = "agent-malformed";
        const turnId = "turn-malformed";

        env.adapter.addRead(
          agentId,
          turnId,
          makeRead(agentId, turnId, [{ role: "user", content: "do a thing" }], 10),
        );
        // The curator returns prose containing a sentinel secret on every run.
        env.adapter.setTextSequence(
          agentId,
          turnId,
          "I think maybe I should save this. " + SENTINEL,
          "I think maybe I should save this. " + SENTINEL,
          "I think maybe I should save this. " + SENTINEL,
        );

        const row = env.store.enqueue(agentId, turnId);
        expect(row).not.toBeNull();

        await env.orch.processPending();

        // The curator was attempted exactly maxRetries (3) times within the
        // single drain.
        expect(env.adapter.runCuratorCalls.filter((c) => c.turnId === turnId)).toHaveLength(3);

        const rec = env.store.get(agentId, turnId);
        expect(rec?.status).toBe("failed");
        expect(rec?.attempts).toBe(3);
        expect(rec?.error).toBeDefined();
        if (rec === null || rec.status !== "failed" || rec.error === undefined) {
          throw new Error("test precondition: row is not terminal-failed with an error");
        }
        // The persisted error must never carry the sentinel or raw output.
        expect(rec.error).not.toContain(SENTINEL);
        expect(rec.error).not.toContain("I think maybe I should save this");
        // And it must remain bounded.
        expect(rec.error.length).toBeLessThanOrEqual(500);
        expect(env.notifications).toEqual([
          {
            outcome: "failed",
            sourceAgentId: agentId,
            turnId,
          },
        ]);
      } finally {
        teardown(env);
      }
    });

    it("does not notify when retry terminalization finds an already-transitioned claim", async () => {
      const env = setup();
      try {
        const agentId = "agent-stale-failure";
        const turnId = "turn-stale-failure";
        env.adapter.addRead(
          agentId,
          turnId,
          makeRead(agentId, turnId, [{ role: "user", content: "extract workflow" }], 10),
        );
        env.adapter.setFinalText(agentId, turnId, "not json");
        env.store.enqueue(agentId, turnId);
        env.store.retryOrFail = () => "unchanged";

        await env.orch.processPending();

        expect(env.notifications).toEqual([]);
      } finally {
        teardown(env);
      }
    });

    it("a nothing_to_save carrying operations or a readSet retries and then terminal-fails without calling the manager", async () => {
      const env = setup();
      try {
        const agentId = "agent-inconsistent-nothing";
        const turnId = "turn-inconsistent";

        env.adapter.addRead(
          agentId,
          turnId,
          makeRead(agentId, turnId, [{ role: "user", content: "what's the weather" }], 10),
        );
        // Valid nothing_to_save verdict but carrying a patch op and a readSet
        // entry — inconsistent: a nothing verdict must carry no mutations.
        const inconsistentNothing = JSON.stringify({
          summary: "Nothing reusable.",
          outcome: "nothing_to_save",
          operations: [
            {
              type: "patch" as const,
              skillName: "git-hygiene",
              path: "SKILL.md",
              oldText: "## Rules",
              newText: "## Rules (v2)",
            },
          ],
          readSet: [{ skillName: "git-hygiene", path: "SKILL.md", content: SKILL_MD, hash: SKILL_MD_HASH }],
        });
        env.adapter.setTextSequence(agentId, turnId, inconsistentNothing, inconsistentNothing, inconsistentNothing);

        const row = env.store.enqueue(agentId, turnId);
        expect(row).not.toBeNull();

        await env.orch.processPending();

        // Retried to the cap, then terminal-failed.
        expect(env.adapter.runCuratorCalls.filter((c) => c.turnId === turnId)).toHaveLength(3);
        const rec = env.store.get(agentId, turnId);
        expect(rec?.status).toBe("failed");
        expect(rec?.attempts).toBe(3);
        // The manager was never invoked for the inconsistent batch.
        expect(env.manager.calls).toHaveLength(0);
      } finally {
        teardown(env);
      }
    });

    it("a skill-manager rejected outcome retries to the cap and terminal-fails; never marks applied", async () => {
      const env = setup();
      try {
        const agentId = "agent-rejected";
        const turnId = "turn-rejected";

        env.adapter.addRead(
          agentId,
          turnId,
          makeRead(agentId, turnId, [{ role: "user", content: "extract the workflow" }], 10),
        );
        env.adapter.setFinalText(agentId, turnId, SAVED_FINAL_TEXT);
        // Every apply attempt reports rejected.
        env.manager.setScript(agentId, turnId, "rejected", "rejected", "rejected");

        const row = env.store.enqueue(agentId, turnId);
        expect(row).not.toBeNull();

        await env.orch.processPending();

        expect(env.manager.calls).toHaveLength(3);
        const rec = env.store.get(agentId, turnId);
        expect(rec?.status).toBe("failed");
        expect(rec?.attempts).toBe(3);
        expect(rec?.error).toBeDefined();
      } finally {
        teardown(env);
      }
    });

    it("a rolled_back outcome retries to the cap and terminal-fails; never marks applied", async () => {
      const env = setup();
      try {
        const agentId = "agent-rolled-back";
        const turnId = "turn-rolled-back";

        env.adapter.addRead(
          agentId,
          turnId,
          makeRead(agentId, turnId, [{ role: "user", content: "extract the workflow" }], 10),
        );
        env.adapter.setFinalText(agentId, turnId, SAVED_FINAL_TEXT);
        env.manager.setScript(agentId, turnId, "rolled_back", "rolled_back", "rolled_back");

        env.store.enqueue(agentId, turnId);

        await env.orch.processPending();

        const rec = env.store.get(agentId, turnId);
        expect(rec?.status).toBe("failed");
        expect(rec?.attempts).toBe(3);
        expect(env.manager.calls).toHaveLength(3);
      } finally {
        teardown(env);
      }
    });

    it("a rollback_failed outcome terminal-fails immediately without replaying a compromised filesystem", async () => {
      const env = setup();
      try {
        const agentId = "agent-rollback-failed";
        const turnId = "turn-rollback-failed";

        env.adapter.addRead(
          agentId,
          turnId,
          makeRead(agentId, turnId, [{ role: "user", content: "extract the workflow" }], 10),
        );
        env.adapter.setFinalText(agentId, turnId, SAVED_FINAL_TEXT);
        env.manager.setScript(agentId, turnId, "rollback_failed", "rollback_failed", "rollback_failed");

        env.store.enqueue(agentId, turnId);

        await env.orch.processPending();

        const rec = env.store.get(agentId, turnId);
        expect(rec?.status).toBe("failed");
        expect(rec?.attempts).toBe(1);
        expect(rec?.error).toBe("rollback failed; reconciliation required");
        expect(env.manager.calls).toHaveLength(1);
      } finally {
        teardown(env);
      }
    });

    it.each([
      ["readWholeTurn", "read"],
      ["runCurator", "curator"],
    ] as const)(
      "%s thrown errors retry to the cap, and the stored error contains only structural identity/category, never the thrown sentinel",
      async (method, label) => {
        const env = setup();
        try {
          const agentId = `agent-throw-${label}`;
          const turnId = `turn-throw-${label}`;

          if (label === "read") {
            // No read configured, but a scripted throw is: every read attempt
            // throws an error whose message embeds a sentinel.
            env.adapter.setReadThrow(agentId, turnId, new Error(`daemon blew up: ${SENTINEL}`));
          } else {
            env.adapter.addRead(
              agentId,
              turnId,
              makeRead(agentId, turnId, [{ role: "user", content: "do a thing" }], 10),
            );
            // The curator run itself throws with a sentinel-carrying message.
            env.adapter.setCuratorThrow(agentId, turnId, new Error(`provider exploded: ${SENTINEL}`));
          }

          env.store.enqueue(agentId, turnId);

          await env.orch.processPending();

          // Attempted exactly maxRetries times.
          const attempts = label === "read" ? env.adapter.readWholeTurnCalls : env.adapter.runCuratorCalls;
          expect(attempts.filter((c) => c.turnId === turnId)).toHaveLength(3);

          const rec = env.store.get(agentId, turnId);
          expect(rec?.status).toBe("failed");
          expect(rec?.attempts).toBe(3);
          expect(rec?.error).toBeDefined();
          // Structural identity and category are present...
          expect(rec!.error).toContain(agentId);
          expect(rec!.error).toContain(turnId);
          expect(rec!.error).toContain("Error");
          // ...but the thrown sentinel message never leaks.
          expect(rec!.error).not.toContain(SENTINEL);
          expect(rec!.error).not.toContain("daemon blew up");
          expect(rec!.error).not.toContain("provider exploded");
          expect(rec!.error?.length).toBeLessThanOrEqual(500);
        } finally {
          teardown(env);
        }
      },
    );
  });
});
