import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProductionRuntime } from "../../index.server";
import { makeTempRoot, cleanupRoot } from "../fixtures";
import type { PluginConfig } from "../../server/contracts";
import { CuratorStore } from "../../server/store";

const roots: string[] = [];

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("expected skill file was not created");
}

describe("curator plugin end to end", () => {
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
        id: "source-1", provider: "provider/example-model", cwd: root, status: "idle",
        createdAt: "2040-01-01T00:00:00.000Z", updatedAt: "2040-01-01T00:00:01.000Z",
        metadata: {},
      },
      entries: [{
        provider: "provider/example-model", turnId: "turn-1",
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
      agents: {
        list: async () => ({ entries: [], pageInfo: {}, requestId: "req-1" }),
        ref: () => ({ timeline: { refetch: async () => page } }),
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
      { id: "source-1", provider: "provider/example-model", cwd: root },
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
