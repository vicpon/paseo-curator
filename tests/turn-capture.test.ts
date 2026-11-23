import { expect, it } from "vitest";
import { join } from "node:path";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CuratorStore } from "../server/store";
import { CuratorOrchestrator } from "../server/orchestrator";
import { SkillManager } from "../server/skill-manager";
import { TurnReadError, type WholeTurnRead } from "../server/paseo-adapter";
import { buildReviewPrompt } from "../server/review-prompt";
import { cleanupRoot, makeTempRoot } from "./fixtures";

it("reads an unexpired capture while another SQLite WAL writer holds a transaction", () => {
  const root = makeTempRoot("capture-read-lock");
  const db = join(root, "capture.sqlite");
  const store = new CuratorStore(db);
  const writer = new DatabaseSync(db);
  try {
    store.recordIteration("source", 10, "turn", {
      sourceAgentId: "source", turnId: "turn", provider: "test/model", model: null, cwd: root,
      entries: [{ role: "user", content: "Exact source marker" }], usedSkillNames: [], toolIterations: 10,
    });
    const row = store.get("source", "turn")!;
    const capture = store.readCapturedTurn(row);
    writer.exec("BEGIN IMMEDIATE");
    expect(store.readCapturedTurn(row)).toEqual(capture);
  } finally {
    try { writer.exec("ROLLBACK"); } catch { /* already released */ }
    writer.close(); store.close(); cleanupRoot(root);
  }
});

it.each(["escaped-payload", "long-skill-name"])("preserves cadence and enqueues without a witness when capture encoding fails: %s", failure => {
  const store = new CuratorStore(":memory:");
  const read: WholeTurnRead = {
    sourceAgentId: "source", turnId: "turn", provider: "test/model", model: null, cwd: "/scratch",
    entries: failure === "escaped-payload"
      ? Array.from({ length: 31 }, () => ({ role: "tool", content: "\u001b".repeat(5000) }))
      : [],
    usedSkillNames: failure === "long-skill-name" ? ["x".repeat(129)] : [], toolIterations: 10,
  };
  try {
    expect(store.recordIteration("source", 10, "turn", read)).toBe(true);
    const row = store.get("source", "turn")!;
    expect(row.status).toBe("pending");
    expect(store.hasObservedTurn("source", "turn")).toBe(true);
    expect(store.getCounter("source")).toBe(0);
    expect(store.hasCapturedTurn(row.id)).toBe(false);
    expect(store.readCapturedTurn(row)).toBeNull();
    expect(store.recordIteration("source", 10, "turn", read)).toBe(true);
    expect(store.recordIteration("source", 10, "next", { ...read, turnId: "next", entries: [], usedSkillNames: [] })).toBe(true);
    expect(store.hasCapturedTurn(store.get("source", "next")!.id)).toBe(true);
  } finally { store.close(); }
});

it("does not encode a capture below threshold but still rejects mismatched turn identity", () => {
  const store = new CuratorStore(":memory:");
  const read: WholeTurnRead = {
    sourceAgentId: "source", turnId: "below", provider: "x".repeat(513), model: null, cwd: "/scratch",
    entries: [], usedSkillNames: ["x".repeat(129)], toolIterations: 1,
  };
  try {
    expect(store.recordIteration("source", 1, "below", read)).toBe(false);
    expect(store.getCounter("source")).toBe(1);
    expect(store.hasObservedTurn("source", "below")).toBe(true);
    expect(store.get("source", "below")).toBeNull();
    expect(() => store.recordIteration("source", 1, "different", read)).toThrow("identity mismatch");
    expect(() => store.recordIteration("source", 1, "below", { ...read, sourceAgentId: "different" })).toThrow("identity mismatch");
    expect(store.getCounter("source")).toBe(1);
    expect(store.hasObservedTurn("source", "different")).toBe(false);
  } finally { store.close(); }
});

it.each([
  "x".repeat(4000) + "truncated tail",
  "x".repeat(3998) + "<&" + "escaped truncated tail",
])("renders the same bounded prompt from live and captured turn text", content => {
  const store = new CuratorStore(":memory:");
  const read: WholeTurnRead = {
    sourceAgentId: "source", turnId: "turn", provider: "test/model", model: null,
    cwd: "/scratch", entries: Array.from({ length: 35 }, () => ({ role: "user", content })),
    usedSkillNames: [], toolIterations: 10,
  };
  try {
    const livePrompt = buildReviewPrompt({ ...read, skills: [] }).prompt;
    expect(livePrompt).toContain("[earlier entries omitted]");
    expect(livePrompt).toContain("\u2026");
    store.recordIteration("source", 10, "turn", read);
    const capture = store.readCapturedTurn(store.get("source", "turn")!)!;
    expect(buildReviewPrompt({ ...capture, skills: [] }).prompt).toBe(livePrompt);
  } finally { store.close(); }
});

it("reviews the exact captured turn after restart and provider history replacement", async () => {
  const root = makeTempRoot("captured-turn");
  const db = join(root, "queue.sqlite");
  let store = new CuratorStore(db);
  const read: WholeTurnRead = { sourceAgentId: "source", turnId: "original", provider: "test/model", model: null,
    cwd: root, entries: [{ role: "user", content: "Exact source marker" }], usedSkillNames: [], toolIterations: 10 };
  const first = new CuratorOrchestrator({ store, skillManager: new SkillManager(root), listSkills: async () => [], schedule: () => {},
    adapter: { readWholeTurn: async () => read, runCurator: async () => { throw Error("not scheduled yet"); } } });
  try {
    await first.handleCompletedTurn({ id: "source", provider: "test", cwd: root }, "original");
    await first.shutdown(); store.close(); store = new CuratorStore(db);
    let refetches = 0;
    const second = new CuratorOrchestrator({ store, skillManager: new SkillManager(root), listSkills: async () => [], schedule: () => {},
      adapter: { readWholeTurn: async () => { refetches++; throw new TurnReadError("turn not found"); },
        runCurator: async (agent, turn, prompt, _id, _files, submit) => {
          expect(agent.provider).toBe("test/model"); expect(turn).toBe("original");
          expect(prompt).toContain("Exact source marker");
          await submit!({ summary: "No reusable lesson", outcome: "nothing_to_save", operations: [] }, async () => true);
          return { curatorAgentId: "review", finalText: "ignored" };
        } } });
    await second.processPending(); await second.shutdown();
    expect(store.get("source", "original")?.status).toBe("nothing_to_save");
    expect(refetches).toBe(0);
  } finally { store.close(); cleanupRoot(root); }
});

it.each([true, false])("only stops retrying exhausted history already witnessed at completion: witnessed=%s", async witnessed => {
  const root = makeTempRoot("missing-turn");
  const store = new CuratorStore(":memory:", { maxRetries: 3 });
  store.recordIteration("source", 10, "original", witnessed ? {
    sourceAgentId: "source", turnId: "original", provider: "test/model", model: null, cwd: root, entries: [], usedSkillNames: [], toolIterations: 10,
  } : undefined);
  if (witnessed) store.deleteCapturedTurns("source");
  let reads = 0;
  const orchestrator = new CuratorOrchestrator({ store, skillManager: new SkillManager(root), listSkills: async () => [], schedule: () => {},
    adapter: { readWholeTurn: async () => { reads++; throw new TurnReadError("timeline exhausted", "turn-not-found"); },
      runCurator: async () => { throw Error("must not invent another turn"); } } });
  try {
    await orchestrator.processPending();
    expect(store.get("source", "original")).toMatchObject({ status: "failed", attempts: witnessed ? 1 : 3 });
    expect(reads).toBe(witnessed ? 1 : 3);
    if (witnessed) expect(store.get("source", "original")?.error).toContain("source-history-unavailable");
    expect(store.listAudit()).toEqual([]);
  } finally { await orchestrator.shutdown(); store.close(); cleanupRoot(root); }
});

it("bounds capture retention, preserves the first identity snapshot, and deletes on terminal outcome", () => {
  const root = makeTempRoot("capture-retention");
  let now = Date.parse("2040-01-01");
  const store = new CuratorStore(join(root, "queue.sqlite"), { now: () => new Date(now) });
  const read = (turnId: string): WholeTurnRead => ({ sourceAgentId: "source", turnId, provider: "test/model", model: null,
    cwd: root, entries: Array.from({ length: 80 }, (_, n) => ({ role: "user", content: `${n}:` + "x".repeat(9000) })), toolIterations: 10, usedSkillNames: [] });
  try {
    const first = read("first");
    store.recordIteration("source", 10, "first", first);
    const row = store.get("source", "first")!;
    const captured = store.readCapturedTurn(row)!;
    expect(captured.entries).toHaveLength(31);
    expect(captured.entries[0].content).toBe(first.entries[49].content.slice(0, 4001));
    expect(captured.entries.at(-1)?.content).toHaveLength(4001);
    store.recordIteration("source", 10, "first", { ...first, entries: [{ role: "user", content: "replacement must not win" }] });
    expect(store.readCapturedTurn(row)).toEqual(captured);
    expect(() => store.recordIteration("source", 10, "wrong-id", first)).toThrow("identity mismatch");
    expect(store.get("source", "wrong-id")).toBeNull();
    const claim = store.claim(row.id)!;
    expect(store.fail(row.id, "wrong attempt", claim.attempts + 1)).toBe(false);
    expect(store.readCapturedTurn(row)).toEqual(captured);
    store.fail(row.id, "terminal", claim.attempts);
    expect(store.readCapturedTurn(row)).toBeNull();
    store.recordIteration("source", 1, "below", { ...read("below"), toolIterations: 1 });
    expect(store.get("source", "below")).toBeNull();
    for (let n = 0; n < 101; n++) store.recordIteration("source", 10, `bounded-${n}`, { ...read(`bounded-${n}`), entries: [] });
    expect(store.readCapturedTurn(store.get("source", "bounded-0")!)).toBeNull();
    const newest = store.get("source", "bounded-100")!;
    expect(store.readCapturedTurn(newest)?.turnId).toBe("bounded-100");
    store.deleteCapturedTurns("another-source");
    expect(store.readCapturedTurn(newest)).not.toBeNull();
    now += 24 * 60 * 60 * 1000;
    expect(store.readCapturedTurn(newest)).toBeNull();
    store.recordIteration("source", 10, "purge", { ...read("purge"), entries: [] });
    store.deleteCapturedTurns("source");
    expect(store.readCapturedTurn(store.get("source", "purge")!)).toBeNull();
  } finally { store.close(); cleanupRoot(root); }
});

it("retains retries for genuine timeline reset races even on previously witnessed turns", async () => {
  const root = makeTempRoot("transient-turn");
  const store = new CuratorStore(":memory:");
  store.recordIteration("source", 10, "original", {
    sourceAgentId: "source", turnId: "original", provider: "test/model", model: null,
    cwd: root, entries: [], usedSkillNames: [], toolIterations: 10,
  });
  const row = store.get("source", "original")!;
  store.deleteCapturedTurns("source");
  expect(store.readCapturedTurn(row)).toBeNull();
  expect(store.hasCapturedTurn(row.id)).toBe(true);
  let reads = 0;
  const orchestrator = new CuratorOrchestrator({ store, skillManager: new SkillManager(root), listSkills: async () => [], schedule: () => {},
    adapter: { readWholeTurn: async () => {
      if (++reads === 1) throw new TurnReadError("timeline reset");
      return { sourceAgentId: "source", turnId: "original", provider: "test/model", model: null, cwd: root, entries: [], usedSkillNames: [], toolIterations: 10 };
    }, runCurator: async (_agent, _turn, _prompt, _id, _files, submit) => {
      await submit!({ summary: "No reusable lesson", outcome: "nothing_to_save", operations: [] }, async () => true);
      return { curatorAgentId: "review", finalText: "ignored" };
    } } });
  try { await orchestrator.processPending(); expect(store.get("source", "original")).toMatchObject({ status: "nothing_to_save", attempts: 2 }); }
  finally { await orchestrator.shutdown(); store.close(); cleanupRoot(root); }
});

it("keeps transcript-bearing SQLite and WAL private to the current user", () => {
  const root = makeTempRoot("capture-permissions");
  const db = join(root, "capture.sqlite");
  const store = new CuratorStore(db);
  try {
    store.recordIteration("source", 10, "turn", { sourceAgentId: "source", turnId: "turn", provider: "test/model", model: null,
      cwd: root, entries: [{ role: "user", content: "Private scratch marker" }], toolIterations: 10, usedSkillNames: [] });
    expect(statSync(db).mode & 0o777).toBe(0o600);
    expect(statSync(db + "-wal").mode & 0o777).toBe(0o600);
    expect(statSync(db + "-shm").mode & 0o777).toBe(0o600);
  } finally { store.close(); cleanupRoot(root); }
});
