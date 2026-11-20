import { liveSnapshot, claudeControls, codexControls, routingSnapshot, routingModels, routingControls } from "./routing-fixtures";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { RoutingProviders, ReadOnlyConfig } from "../shared/routing";
import { discoverRoutingProviders, resolveReadOnlyConfig } from "../shared/routing";

const entries: Awaited<ReturnType<RoutingProviders["waitForReady"]>>["entries"] = [
  { provider: "omp", label: "Oh My Pi", status: "ready", enabled: true },
  { provider: "codex", status: "ready", enabled: false },
  { provider: "claude", status: "ready", enabled: true },
  { provider: "hermes", status: "unavailable", enabled: true },
  { provider: "future", status: "ready", enabled: true },
];
const providers = () => ({
  waitForReady: vi.fn(async () => routingSnapshot(entries)),
  listModels: vi.fn(async (provider: string) => routingModels(provider, [{ id: "nested/model", label: "Model" }])),
  listControls: vi.fn(routingControls),
});

describe("provider routing discovery", () => {
  it("discovers the host catalog independent of order or preferred names and retains unavailable entries", async () => {
    const api = providers();
    const first = await discoverRoutingProviders(api);
    api.waitForReady.mockResolvedValue(routingSnapshot([...entries].reverse()));
    expect(await discoverRoutingProviders(api)).toEqual(first);
    expect(first.map(p => p.id).sort()).toEqual(entries.map(p => p.provider).sort());
    expect(first.find(p => p.id === "claude")?.supported).toBe(true);
    expect(first.find(p => p.id === "codex")).toMatchObject({ supported: false, reason: "Disabled in host settings." });
    expect(first.find(p => p.id === "future")?.supported).toBe(false);
  });
});

describe("native route controls", () => {
  it("uses Codex sandbox options even when there is no read-only session mode", async () => {
    const config = await resolveReadOnlyConfig(providers(), "codex/nested/model", "/repo");
    expect(config).toMatchObject({ provider: "codex/nested/model", options: { sandbox_mode: "read-only", approval_policy: "never" } });
    expect(config).not.toHaveProperty("modeId");
  });
  it("restricts Claude's native tools and denies every MCP tool rather than trusting ask mode", async () => {
    expect(await resolveReadOnlyConfig(providers(), "claude/model", "/repo")).toMatchObject({
      options: { extraArgs: { tools: "Read,Glob,Grep" }, disallowedTools: ["mcp__*"] },
    });
  });
  it("fails closed if the host cannot resolve or strips required controls", async () => {
    const api = providers();
    api.listControls.mockResolvedValue({ ...codexControls.result, options: {}, error: null });
    expect(await resolveReadOnlyConfig(api, "codex/model", "/repo")).toBeNull();
    expect(await resolveReadOnlyConfig({ ...api, listControls: undefined }, "claude/model", "/repo")).toBeNull();
    expect(await resolveReadOnlyConfig(api, "omp/model", "/repo")).toBeNull();
  });
});


it("uses the installed Paseo SDK catalog and creation contracts", () => {
  type Api = PluginHookContext["paseo"];
  expectTypeOf<Api["providers"]>().toMatchTypeOf<RoutingProviders>();
  expectTypeOf<ReadOnlyConfig>().toMatchTypeOf<Parameters<Api["agents"]["create"]>[0]["config"]>();
});

describe("authenticated daemon protocol regression", () => {
  it("discovers ready providers from the SDK snapshot and resolves their native controls", async () => {
    const api = {
      waitForReady: async () => liveSnapshot,
      listModels: async (provider: string) => ({ models: [{ id: (provider === "claude" ? claudeControls : codexControls).draft.provider.split("/").slice(1).join("/"), label: "Default", provider }], provider, fetchedAt: liveSnapshot.generatedAt, requestId: "models" }),
      listControls: vi.fn(async (draft: Parameters<NonNullable<RoutingProviders["listControls"]>>[0]) => {
        const capture = draft.provider.startsWith("claude/") ? claudeControls : codexControls;
        expect(draft).toEqual({ ...capture.draft, cwd: "." });
        return capture.result;
      }),
    };
    const catalog = await discoverRoutingProviders(api);
    expect(catalog.filter(entry => entry.supported).map(entry => entry.id)).toEqual(["claude", "codex"]);
    for (const provider of ["omp", "hermes", "opencode", "glm-acp-agent"]) {
      expect(catalog.find(entry => entry.id === provider)).toMatchObject({ supported: false, reason: expect.not.stringContaining("Unavailable on this host") });
    }
    expect(api.listControls).toHaveBeenCalledTimes(2);
  });
});
