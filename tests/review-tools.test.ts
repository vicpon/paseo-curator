import { describe, expect, it, vi } from "vitest";
import type { AgentToolContext, PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";

async function registry() {
  // Dynamic lookup gives a specific missing-capability RED before the module exists.
  const modulePath = "../server/review-tools";
  const mod = await import(modulePath).catch(() => ({}));
  expect(mod.ReviewTools, "identity-bound review tool registration is required").toBeTypeOf("function");
  let hook: (payload: { request: PluginSessionOpenRequest }) => unknown;
  const registrations: string[] = [];
  const register = (name: string, handler: typeof hook) => { registrations.push(name); hook = handler; return () => {}; };
  const server = { addHook: register, before: register } as unknown as PluginServerContext;
  const tools = new mod.ReviewTools(server);
  return { tools, registrations, open: (request: PluginSessionOpenRequest) => hook!({ request }) };
}
const request = (agentId = "review"): PluginSessionOpenRequest => ({ agentId, provider: "custom", cwd: "/scratch", purpose: "interactive",
  reason: "create", workspaceId: null, title: "review", background: true, labels: {}, metadata: {}, tools: [], env: {}, mcpServers: {} });
const context = (agentId = "review"): AgentToolContext => ({ agent: { id: agentId, provider: "custom", cwd: "/scratch", parentAgentId: "source",
  workspaceId: null, title: "review", background: true, metadata: {} }, paseo: {} as never, signal: new AbortController().signal });
const noop = { summary: "No lesson", outcome: "nothing_to_save", operations: [] };

describe("trusted reviewer tool bindings", () => {
  it("only injects into plugin-bound identity, never source or marker-spoofed agents", async () => {
    const { tools, open, registrations } = await registry();
    expect(registrations).toEqual(["agent.open.before"]);
    const submit = vi.fn(async () => ({ text: "accepted" }));
    const binding = tools.bind({ agentId: "review", provider: "custom/model", cwd: "/scratch", sourceAgentId: "source", turnId: "turn",
      reviewId: "queue:1", authorized: async () => true, submit });
    expect(await open({ ...request("source"), metadata: { "paseo.curator": true } })).toBeUndefined();
    const attached = await open(request()) as PluginSessionOpenRequest;
    expect(attached.tools).toHaveLength(1);
    expect(binding.attached).toBe(true);
    const tool = attached.tools[0];
    expect((await tool.execute(noop, context("source"))).isError).toBe(true);
    expect((await tool.execute(noop, context())).isError).not.toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    await binding.close();
    expect((await tool.execute(noop, context())).isError).toBe(true);
    expect(await open(request())).toBeUndefined();
  });

  it("does not let model-provided authority or revoked routing reach the manager", async () => {
    const { tools, open } = await registry();
    let consent = true;
    const submit = vi.fn(async () => ({ text: "accepted" }));
    tools.bind({ agentId: "review", provider: "custom/model", cwd: "/scratch", sourceAgentId: "source", turnId: "turn", reviewId: "queue:1",
      authorized: async () => consent, submit });
    const tool = (await open(request()) as PluginSessionOpenRequest).tools[0];
    const invalid = await tool.input.parseAsync({ ...noop, agentId: "review", claimAttempt: 1 });
    // The host's schema errors must travel through the bounded submission handler.
    await tool.execute(invalid, context());
    expect(submit).toHaveBeenCalledTimes(1);
    consent = false;
    expect((await tool.execute(noop, context())).isError).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("contains authorization lookup errors without leaking provider values", async () => {
    const { tools, open } = await registry();
    tools.bind({ agentId: "review", provider: "custom/model", cwd: "/scratch", sourceAgentId: "source", turnId: "turn", reviewId: "queue:1",
      authorized: async () => { throw new Error("private-provider-value"); }, submit: async () => ({ text: "must not reach" }) });
    const tool = (await open(request()) as PluginSessionOpenRequest).tools[0];
    const reply = await tool.execute(noop, context());
    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply)).not.toContain("private-provider-value");
  });

});
