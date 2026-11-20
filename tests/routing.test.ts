import { liveSnapshot, routingSnapshot, routingModels } from "./routing-fixtures";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { RoutingProviders } from "../shared/routing";
import { discoverRoutingProviders } from "../shared/routing";

const families = ["claude", "codex", "opencode", "omp", "hermes", "glm-acp-agent", "arbitrary-provider"];
const providers = () => ({
  waitForReady: vi.fn(async () => routingSnapshot([
    ...families.map(provider => ({ provider, status: "ready" as const, enabled: true })),
    { provider: "disabled", status: "ready" as const, enabled: false },
    { provider: "unavailable", status: "unavailable" as const, enabled: true },
  ])),
  listModels: vi.fn(async (provider: string) => routingModels(provider, [{ id: "vendor/model", label: "Model" }])),
  listControls: vi.fn(async () => { throw new Error("No native controls exposed"); }),
});

describe("host-owned provider eligibility", () => {
  it("offers every enabled ready family without a confinement or mode lookup", async () => {
    const api = providers();
    const catalog = await discoverRoutingProviders(api);
    expect(catalog.filter(p => p.supported).map(p => p.id)).toEqual([...families].sort());
    expect(catalog.some(p => p.id === "disabled")).toBe(false);
    expect(catalog.find(p => p.id === "unavailable")?.supported).toBe(false);
    expect(api.listModels).not.toHaveBeenCalledWith("disabled");
    expect(api.listModels).not.toHaveBeenCalledWith("unavailable");
    expect(api.listControls).not.toHaveBeenCalled();
  });
  it("does not make model enumeration another eligibility gate", async () => {
    const api = providers();
    api.listModels.mockRejectedValue(new Error("Models unavailable"));
    const catalog = await discoverRoutingProviders(api);
    expect(catalog.filter(p => p.supported).map(p => p.id)).toEqual([...families].sort());
    expect(catalog.find(p => p.id === "omp")?.models).toEqual([]);
  });
  it("matches the real SDK catalog readiness contract independent of ordering", async () => {
    const api = providers();
    api.waitForReady.mockResolvedValue(liveSnapshot);
    const catalog = await discoverRoutingProviders(api);
    expect(catalog.filter(p => p.supported).map(p => p.id)).toEqual(["claude", "codex", "glm-acp-agent", "hermes", "omp", "opencode"]);
    api.waitForReady.mockResolvedValue(routingSnapshot([...liveSnapshot.entries].reverse()));
    expect(await discoverRoutingProviders(api)).toEqual(catalog);
  });
});
it("uses the installed SDK catalog contract", () => {
  expectTypeOf<PluginHookContext["paseo"]["providers"]>().toMatchTypeOf<RoutingProviders>();
});
