import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CuratorOrchestrator } from "../server/orchestrator";
import { CuratorStore } from "../server/store";
import { acquireSkillLocks, releaseSkillLocks } from "../server/skill-files";
import { SkillManager, type SkillManagerOptions } from "../server/skill-manager";
import { cleanupRoot, createSkill, makeTempRoot, skillMd } from "./fixtures";

// The transport is scripted; mutation, snapshots, claims, receipts and SQLite are real.
type Reply = { isError?: boolean; text?: string; structuredContent?: unknown };
type Submit = (input: unknown, authorized: () => Promise<boolean>) => Promise<Reply>;
const noop = { summary: "No reusable lesson", outcome: "nothing_to_save", operations: [] };
const patch = (oldText = "Original") => ({ summary: "A verified lesson", outcome: "saved", operations: [
  { type: "patch", skillName: "alpha", path: "references/notes.md", oldText, newText: "Corrected" },
] });
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.restoreAllMocks(); });

function fixture(run: (submit: Submit, store: CuratorStore) => Promise<void>, finalText = "malformed final { prose", maxRetries = 1, managerOptions?: SkillManagerOptions, notify?: () => Promise<void>) {
  const root = makeTempRoot("structured-review");
  createSkill(root, "alpha", skillMd("alpha", "Existing"), { "references/notes.md": "Original" });
  const store = new CuratorStore(join(root, "state.sqlite"), { maxRetries });
  cleanup.push(() => { store.close(); cleanupRoot(root); });
  let runs = 0;
  let handlerAvailable = false;
  const orchestrator = new CuratorOrchestrator({
    store, skillManager: new SkillManager(root, managerOptions), listSkills: async () => [], schedule: () => {}, notify,
    adapter: {
      readWholeTurn: async () => ({ sourceAgentId: "source", turnId: "turn", provider: "test/model", model: null,
        cwd: root, entries: [], usedSkillNames: [], toolIterations: 10 }),
      runCurator: async (...args: unknown[]) => {
        runs++;
        const submit = args[5];
        handlerAvailable = typeof submit === "function";
        expect(submit, "the running reviewer must receive a submission handler").toBeTypeOf("function");
        await run(submit as Submit, store);
        return { curatorAgentId: "trusted-reviewer", finalText };
      },
    },
  });
  store.enqueue("source", "turn");
  return { store, root, path: join(root, "alpha", "references/notes.md"), orchestrator, runs: () => runs, handlerAvailable: () => handlerAvailable };
}
const allowed = async () => true;

describe("structured review durable protocol", () => {
  it("returns invalid oldText feedback then accepts a corrected submission in the same run", async () => {
    const f = fixture(async submit => {
      const bad = await submit(patch("Wrong"), allowed);
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/oldText/);
      expect((await submit(patch(), allowed)).isError).not.toBe(true);
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")?.status).toBe("applied");
    expect(f.runs()).toBe(1);
    expect(readFileSync(f.path, "utf8")).toBe("Corrected");
    expect(f.store.listAudit().filter(a => a.outcome === "applied")).toHaveLength(1);
  });

  it("records successful submission before malformed final assistant prose", async () => {
    const f = fixture(async submit => { await submit(patch(), allowed); });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")?.status).toBe("applied");
    expect(f.store.listAudit()[0]?.outcome).toBe("applied");
  });

  it("returns bounded schema feedback without echoing unknown keys or argument values", async () => {
    const f = fixture(async submit => {
      const bad = await submit({ ...noop, operations: "private-value", "private-key": "private-secret" }, allowed);
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/schema/);
      expect(JSON.stringify(bad)).not.toMatch(/private-/);
      expect((await submit(noop, allowed)).isError).not.toBe(true);
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")?.status).toBe("nothing_to_save");
    expect(readFileSync(f.path, "utf8")).toBe("Original");
  });

  it("requires an explicit no-op with zero operations", async () => {
    const f = fixture(async submit => {
      expect((await submit({ ...patch(), outcome: "nothing_to_save" }, allowed)).isError).toBe(true);
      await submit(noop, allowed);
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.listAudit().filter(a => a.outcome === "nothing_to_save")).toHaveLength(1);
    expect(readFileSync(f.path, "utf8")).toBe("Original");
  });

  it("rejects revoked authorization before mutation", async () => {
    const f = fixture(async submit => { expect((await submit(patch(), async () => false)).isError).toBe(true); });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe("Original");
    expect(f.store.get("source", "turn")?.status).toBe("failed");
  });

  it("rejects a stale claim even when the old reviewer still runs", async () => {
    const f = fixture(async (submit, store) => {
      const row = store.get("source", "turn")!;
      store.fail(row.id, "superseded", row.attempts);
      expect((await submit(patch(), allowed)).isError).toBe(true);
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe("Original");
    expect(f.store.listAudit()).toHaveLength(0);
  });

  it("coalesces duplicate concurrent submissions and applies exactly once", async () => {
    const f = fixture(async submit => {
      const replies = await Promise.all([submit(patch(), allowed), submit(patch(), allowed)]);
      expect(replies.every(r => !r.isError)).toBe(true);
      expect(replies[0]).toEqual(replies[1]);
      expect((await submit(noop, allowed)).isError).toBe(true);
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.listAudit().filter(a => a.outcome === "applied")).toHaveLength(1);
    expect(readFileSync(f.path, "utf8")).toBe("Corrected");
  });

  it("keeps accepted effects and audit when the provider later throws", async () => {
    const f = fixture(async (submit, store) => {
      await submit(patch(), allowed);
      expect(store.get("source", "turn")?.status).toBe("applied");
      expect(store.listAudit()[0]?.outcome).toBe("applied");
      throw new Error("private provider failure");
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")?.status).toBe("applied");
    expect(f.runs()).toBe(1);
    expect(readFileSync(f.path, "utf8")).toBe("Corrected");
    expect(existsSync(join(f.root, ".paseo-curator", "receipts", `${f.store.get("source", "turn")!.id}.json`))).toBe(true);
  });

  it("reconciles an applied receipt immediately if queue/audit commit throws after file commit", async () => {
    const f = fixture(async (submit, store) => {
      const complete = store.completeWithAudit.bind(store);
      let throws = true;
      store.completeWithAudit = (...args) => { if (throws) { throws = false; throw new Error("injected commit failure"); } return complete(...args); };
      await submit(patch(), allowed);
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")?.status).toBe("applied");
    expect(f.store.listAudit().filter(a => a.outcome === "applied")).toHaveLength(1);
    expect(f.runs()).toBe(1);
    expect(readFileSync(f.path, "utf8")).toBe("Corrected");
  });

  it("bounds invalid-argument repairs to four submissions in the same review", async () => {
    const f = fixture(async submit => {
      for (let i = 0; i < 4; i++) expect((await submit({ outcome: "bad" }, allowed)).isError).toBe(true);
      expect((await submit(noop, allowed)).text).toMatch(/repair budget exhausted/);
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")?.status).toBe("failed");
    expect(f.store.listAudit()).toHaveLength(0);
  });

  it("rejects an old claim after another generation reclaims the queue row", async () => {
    const f = fixture(async (submit, store) => {
      const old = store.get("source", "turn")!;
      expect(store.retryOrFail(old.id, "superseded", old.attempts)).toBe("pending");
      const newer = store.claimNext()!;
      expect(newer.attempts).toBe(old.attempts + 1);
      expect((await submit(patch(), allowed)).isError).toBe(true);
    }, undefined, 2);
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")).toMatchObject({ status: "running", attempts: 2 });
    expect(f.store.listAudit()).toHaveLength(0);
    expect(readFileSync(f.path, "utf8")).toBe("Original");
  });

  it("rechecks revocation after waiting for the actual skill lock", async () => {
    const f = fixture(async submit => {
      let permitted = true;
      const locks = await acquireSkillLocks(f.root, ["alpha"]);
      try {
        const call = submit(patch(), async () => permitted);
        await new Promise<void>(resolve => setImmediate(resolve));
        permitted = false;
        releaseSkillLocks(locks);
        expect((await call).isError).toBe(true);
      } finally { releaseSkillLocks(locks); }
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")?.status).toBe("failed");
    expect(readFileSync(f.path, "utf8")).toBe("Original");
  });

  it("expires the submission budget even if the provider keeps running", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const f = fixture(async submit => {
      clock.mockReturnValue(now + 300_001);
      expect((await submit(patch(), allowed)).text).toMatch(/time budget exhausted/);
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")?.error).toMatch(/time budget exhausted/);
    expect(readFileSync(f.path, "utf8")).toBe("Original");
  });

  it("retains partial-effects audit after an earlier repair rejection and later provider error", async () => {
    const f = fixture(async (submit, store) => {
      expect((await submit(patch("Wrong"), allowed)).isError).toBe(true);
      const operations = [...patch().operations, { type: "write_file", skillName: "alpha", path: "references/extra.md", content: "fixture" }];
      expect((await submit({ summary: "canary", outcome: "saved", operations }, allowed)).text).toMatch(/rollback failed/);
      expect(store.get("source", "turn")?.status).toBe("failed");
      throw new Error("provider failed after partial effects");
    }, undefined, 1, {
      faultInjector: index => { if (index === 1) throw new Error("injected later-operation failure"); },
      restoreSkillImpl: () => ({ restored: [], removed: [], errors: ["injected restore failure"] }),
    });
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.runs()).toBe(1);
    expect(readFileSync(f.path, "utf8")).toBe("Corrected");
    const audits = f.store.listAudit();
    expect(audits).toHaveLength(2);
    expect(audits.map(a => a.operationCount)).toEqual([1, 2]);
    expect(audits[1].rejectionReason).toContain("rollback_failed");
    expect(audits[1].operationsHash).not.toBe(audits[0].operationsHash);
    expect(f.store.get("source", "turn")?.error).toMatch(/reconciliation required/);
  });

  it("does not hold an accepted tool reply forever when activity notification stalls", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(async submit => { expect((await submit(patch(), allowed)).isError).not.toBe(true); }, undefined, 1, undefined,
        () => new Promise<void>(() => {}));
      const drain = f.orchestrator.processPending();
      await vi.advanceTimersByTimeAsync(2000);
      let finished = false;
      void drain.then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(true);
      expect(f.store.get("source", "turn")?.status).toBe("applied");
    } finally { vi.useRealTimers(); }
  });

  it("fails clearly if a reviewer finishes without submission, even with valid final JSON", async () => {
    const f = fixture(async () => {}, JSON.stringify(noop));
    await f.orchestrator.processPending();
    expect(f.handlerAvailable()).toBe(true);
    expect(f.store.get("source", "turn")?.status).toBe("failed");
    expect(f.store.get("source", "turn")?.error).toMatch(/submission/);
    expect(readFileSync(f.path, "utf8")).toBe("Original");
  });
});

it("serializes batches sharing a manager so maintenance cannot clear another batch's rollback state", async () => {
  const root = makeTempRoot("batch-state");
  const manager = new SkillManager(root);
  createSkill(root, "alpha", skillMd("alpha", "Original"));
  createSkill(root, "beta", skillMd("beta", "Original"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let secondEntered = false;
  const first = manager.applyBatch([{ type: "patch", skillName: "alpha", path: "SKILL.md", oldText: "Original", newText: "First" }], [],
    { queueId: "first", sourceAgentId: "source", turnId: "one", reviewSnapshot: manager.captureReviewSnapshot(), authorized: async () => { await gate; return true; } });
  const second = manager.applyBatch([{ type: "patch", skillName: "beta", path: "SKILL.md", oldText: "Original", newText: "Second" }], [],
    { queueId: "second", sourceAgentId: "source", turnId: "two", reviewSnapshot: manager.captureReviewSnapshot(), authorized: async () => { secondEntered = true; return true; } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(secondEntered).toBe(false);
  } finally {
    release();
    const results = await Promise.all([first, second]);
    expect(results.map(r => r.outcome)).toEqual(["applied", "applied"]);
    cleanupRoot(root);
  }
});
