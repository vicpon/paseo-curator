import { expect, it } from "vitest";
import { CuratorOrchestrator } from "../server/orchestrator";
import { CuratorStore } from "../server/store";
import { SkillManager } from "../server/skill-manager";
import { PaseoAdapter, type CreateAgentOptions } from "../server/paseo-adapter";
import { reviewHost, reviewMcpBridge } from "./review-host";
import { createSkill, makeTempRoot, cleanupRoot, skillMd } from "./fixtures";
import { routingSnapshot, routingModels } from "./routing-fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";

it.each([false, true])("real Paseo hook + MCP + PluginAgentTools schema repairs, budget exhausted=%s", async exhausted => {
  const root = makeTempRoot("host-integration");
  createSkill(root, "canary", skillMd("canary", "Original"));
  const store = new CuratorStore(join(root, "queue.sqlite"), { maxRetries: 1 });
  const host = reviewHost();
  let runs = 0;
  const replies: unknown[] = [];
  const adapter = new PaseoAdapter({ providers: {
    waitForReady: async () => routingSnapshot([{ provider: "custom", enabled: true, status: "ready" }]),
    listModels: async provider => routingModels(provider, []),
  }, agents: {
    ref: () => { throw new Error("not used"); },
    create: async (options: CreateAgentOptions) => {
      expect(options.prompt).toBeUndefined();
      const opened = await host.open(options) as { tools: Array<{ inputSchema: Record<string, unknown>; name: string }> };
      const unauthorized = await host.agentTools.call("source-attack", { id: "source", provider: "custom", cwd: root,
        parentAgentId: null, workspaceId: null, background: true, metadata: { "paseo.curator": true }, title: "spoof" }, "submit_review", {}, {} as never);
      expect(unauthorized.isError).toBe(true);
      expect(opened.tools[0].name).toBe("submit_review");
      expect(opened.tools[0].inputSchema).toMatchObject({ type: "object", properties: { operations: { description: expect.any(String) } } });
      const mcp = await reviewMcpBridge(host, options, opened);
      return { id: options.agentId, capabilities: { supportsMcpServers: true, supportsToolInvocations: true },
        waitForFinish: async () => { throw new Error("must use run after discovery"); },
        run: async () => {
          runs++;
          replies.push(await mcp.call({ outcome: "saved", operations: "invalid-secret" }));
          if (exhausted) {
            for (let i = 0; i < 3; i++) replies.push(await mcp.call({ outcome: "saved", operations: "invalid-secret" }));
            replies.push(await mcp.call({ summary: "No lesson", outcome: "nothing_to_save", operations: [] }));
            await mcp.close();
            return { status: "idle", final: null, error: null, lastMessage: "ignored" };
          }
          replies.push(await mcp.call({ summary: "Verified canary", outcome: "saved", operations: [
            { type: "patch", skillName: "canary", path: "SKILL.md", oldText: "Original", newText: "Corrected" },
          ] }));
          await mcp.close();
          return { status: "idle", final: null, error: null, lastMessage: "malformed final {" };
        },
      };
    },
  } }, undefined, host.reviews);
  const orchestrator = new CuratorOrchestrator({ store, skillManager: new SkillManager(root), schedule: () => {}, listSkills: async () => [],
    adapter: { runCurator: adapter.runCurator.bind(adapter), readWholeTurn: async () => ({ sourceAgentId: "source", turnId: "turn", provider: "custom/model",
      model: null, cwd: root, entries: [], usedSkillNames: [], toolIterations: 10 }) } });
  try {
    store.enqueue("source", "turn");
    await orchestrator.processPending();
    expect(replies[0]).toMatchObject({ isError: true, structuredContent: { accepted: false } });
    if (exhausted) {
      expect(JSON.stringify(replies.at(-1))).toContain("repair budget exhausted");
      expect(store.get("source", "turn")?.status).toBe("failed");
      expect(store.listAudit()).toHaveLength(0);
      expect(readFileSync(join(root, "canary", "SKILL.md"), "utf8")).toContain("Original");
      return;
    }
    expect(JSON.stringify(replies[0])).toContain("schema");
    expect(JSON.stringify(replies[0])).not.toContain("invalid-secret");
    expect(replies[1]).toMatchObject({ structuredContent: { accepted: true } });
    expect(runs).toBe(1);
    expect(store.get("source", "turn")?.status).toBe("applied");
    expect(store.listAudit().filter(a => a.outcome === "applied")).toHaveLength(1);
    expect(readFileSync(join(root, "canary", "SKILL.md"), "utf8")).toContain("Corrected");
  } finally { await orchestrator.shutdown(); await host.close(); store.close(); cleanupRoot(root); }
});
