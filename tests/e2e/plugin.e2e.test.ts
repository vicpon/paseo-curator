import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProductionRuntime } from "../../index.server";
import { makeTempRoot, cleanupRoot, createSkill, skillMd } from "../fixtures";
import type { PluginConfig } from "../../server/contracts";
import { CuratorStore } from "../../server/store";
import { SkillManager } from "../../server/skill-manager";
import { CuratorOrchestrator } from "../../server/orchestrator";
import { PaseoAdapter, type CreateAgentOptions } from "../../server/paseo-adapter";

const roots: string[] = [];

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("expected skill file was not created");
}

describe("curator plugin end to end", () => {
  it.each([
    ["patch", false], ["remove_file", false], ["patch", true], ["remove_file", true],
  ] as const)("captures before review: %s, concurrent change=%s", async (type, changed) => {
    const root = makeTempRoot("curator-review-capture");
    createSkill(root, "alpha", skillMd("alpha", "Original"), { "references/notes.md": "Original" });
    const file = join(root, "alpha", "references/notes.md");
    const store = new CuratorStore(":memory:", { maxRetries: 1 });
    const manager = new SkillManager(root);
    const operation = type === "patch"
      ? { type, skillName: "alpha", path: "references/notes.md", oldText: "Original", newText: "Patched" }
      : { type, skillName: "alpha", path: "references/notes.md" };
    const orchestrator = new CuratorOrchestrator({
      store, skillManager: manager, listSkills: async () => [], schedule: () => {},
      adapter: {
        readWholeTurn: async () => ({ sourceAgentId: "agent", turnId: "turn", provider: "test", model: null,
          cwd: root, entries: [], toolIterations: 10, usedSkillNames: [] }),
        runCurator: async () => {
          if (changed) writeFileSync(file, "Original plus newer content");
          return { curatorAgentId: "review", finalText: JSON.stringify({ summary: "lesson", outcome: "saved", operations: [operation] }) };
        },
      },
    });
    try {
      store.enqueue("agent", "turn");
      await orchestrator.processPending();
      expect(store.get("agent", "turn")?.status).toBe(changed ? "failed" : "applied");
      if (changed) expect(readFileSync(file, "utf8")).toBe("Original plus newer content");
      else if (type === "patch") expect(readFileSync(file, "utf8")).toBe("Patched");
      else expect(existsSync(file)).toBe(false);
    } finally {
      await orchestrator.shutdown();
      store.close();
      cleanupRoot(root);
    }
  });

  it("preserves newer binary support-file bytes after review capture", async () => {
    const root = makeTempRoot("curator-binary-capture");
    createSkill(root, "alpha", skillMd("alpha", "Original"), { "assets/item.bin": "placeholder" });
    const file = join(root, "alpha", "assets/item.bin");
    const manager = new SkillManager(root);
    try {
      writeFileSync(file, Uint8Array.of(0x80));
      const reviewSnapshot = manager.captureReviewSnapshot();
      writeFileSync(file, Uint8Array.of(0x81));
      const result = await manager.applyBatch([{ type: "remove_file", skillName: "alpha", path: "assets/item.bin" }], [],
        { queueId: "binary", sourceAgentId: "agent", turnId: "turn", reviewSnapshot });
      expect(result.outcome).toBe("rejected");
      expect([...readFileSync(file)]).toEqual([0x81]);
    } finally {
      cleanupRoot(root);
    }
  });

  it("starts a fresh review on retry instead of deleting newer content using a reattached review", async () => {
    const root = makeTempRoot("curator-review-retry");
    createSkill(root, "alpha", skillMd("alpha", "Original"), { "references/notes.md": "Original" });
    const file = join(root, "alpha", "references/notes.md");
    const store = new CuratorStore(":memory:", { maxRetries: 2 });
    const results = new Map<string, string>();
    const adapter = new PaseoAdapter({
      providers: {
        waitForReady: async () => ({ entries: [{ provider: "codex", status: "available", enabled: true }] }),
        listModels: async () => ({ models: [] }),
        listControls: async (draft: { providerOptions: Record<string, unknown> }) => ({ options: draft.providerOptions }),
      },
      agents: {
        ref: () => { throw new Error("unused"); },
        create: async (options: CreateAgentOptions) => {
          if (!results.has(options.agentId)) {
            if (results.size === 0) {
              writeFileSync(file, "Newer content added during review");
              results.set(options.agentId, JSON.stringify({ summary: "old proposal", outcome: "saved",
                operations: [{ type: "remove_file", skillName: "alpha", path: "references/notes.md" }] }));
            } else {
              results.set(options.agentId, JSON.stringify({ summary: "new review", outcome: "nothing_to_save", operations: [] }));
            }
          }
          return { id: options.agentId, waitForFinish: async () => ({ status: "idle", final: null, error: null, lastMessage: results.get(options.agentId)! }) };
        },
      },
    });
    const orchestrator = new CuratorOrchestrator({
      store, skillManager: new SkillManager(root), listSkills: async () => [], schedule: () => {},
      adapter: {
        readWholeTurn: async () => ({ sourceAgentId: "agent", turnId: "turn", provider: "codex/model", model: null,
          cwd: root, entries: [], toolIterations: 10, usedSkillNames: [] }),
        runCurator: adapter.runCurator.bind(adapter),
      },
    });
    try {
      store.enqueue("agent", "turn");
      await orchestrator.processPending();
      expect(store.get("agent", "turn")?.status).toBe("nothing_to_save");
      expect(results.size).toBe(2);
      expect(readFileSync(file, "utf8")).toBe("Newer content added during review");
    } finally {
      await orchestrator.shutdown();
      store.close();
      cleanupRoot(root);
    }
  });

  it("turn threshold -> curator result -> guarded skill creation", async () => {
    const root = makeTempRoot("curator-e2e");
    roots.push(root);
    const skillRoot = join(root, "skills");
    const stateDir = join(root, "state");
    const skillContent = `---\nname: learned-workflow\ndescription: Reusable workflow.\ncreated_by: paseo-curator\n---\n\n# Learned workflow\n`;
    const finalText = JSON.stringify({
      summary: "Reusable workflow found.",
      outcome: "saved",
      operations: [{ type: "create", skillName: "learned-workflow", content: skillContent }],
      readSet: [],
    });
    const page = {
      agentId: "source-1",
      agent: {
        id: "source-1", provider: "codex/example-model", cwd: root, status: "idle",
        createdAt: "2040-01-01T00:00:00.000Z", updatedAt: "2040-01-01T00:00:01.000Z",
        metadata: {},
      },
      entries: [{
        provider: "codex/example-model", turnId: "turn-1",
        item: {
          type: "tool_call", callId: "call-1", name: "run_tests", status: "completed", error: null,
          detail: { type: "shell", command: "npm test", cwd: root, output: "PASS" },
        },
      }],
      startCursor: null,
      hasOlder: false,
      error: null,
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
    };
    const paseo = {
      providers: {
        waitForReady: async () => ({ entries: [{ provider: "codex", status: "available", enabled: true }] }),
        listModels: async () => ({ models: [] }),
        listControls: async (draft: { providerOptions: Record<string, unknown> }) => ({ options: draft.providerOptions }),
      },
      agents: {
        list: async () => ({ entries: [], pageInfo: {}, requestId: "req-1" }),
        ref: () => ({ timeline: { refetch: async () => page, append: async () => ({}) } }),
        create: async (options: { agentId: string }) => ({
          id: options.agentId,
          waitForFinish: async () => ({ status: "idle", final: null, error: null, lastMessage: finalText }),
        }),
      },
    };
    const config: PluginConfig = {
      skillRoot,
      reviewThreshold: 1,
      curatorConcurrency: 1,
      maxOperations: 20,
      maintenanceEnabled: false,
      consolidationEnabled: false,
      staleDays: 14,
      archiveDays: 30,
      maxRetries: 3,
    };
    const runtime = createProductionRuntime(paseo as never, config, { stateDir });

    await runtime.start();
    await runtime.handleCompletedTurn(
      { id: "source-1", provider: "codex/example-model", cwd: root },
      "turn-1",
    );
    const skillPath = join(skillRoot, "learned-workflow", "SKILL.md");
    await waitForFile(skillPath);

    expect(readFileSync(skillPath, "utf8")).toBe(skillContent);
    await runtime.shutdown();
    await runtime.close();
    const persisted = new CuratorStore(join(stateDir, "curator.sqlite"));
    expect(persisted.get("source-1", "turn-1")?.status).toBe("applied");
    expect(persisted.listAudit()).toEqual([
      expect.objectContaining({
        sourceAgentId: "source-1",
        turnId: "turn-1",
        outcome: "applied",
        operationCount: 1,
        skillNames: ["learned-workflow"],
      }),
    ]);
    persisted.close();
    cleanupRoot(root);
  });
});
