import { liveSnapshot, routingSnapshot, routingModels, routingControls } from "./routing-fixtures";
import type { RoutingProviders } from "../shared/routing";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const { useSettings, usePaseo, register } = vi.hoisted(() => ({ useSettings: vi.fn(), usePaseo: vi.fn(), register: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings, usePaseo }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsSection: ({ title, info, trailing, children }: { title: string; info: string; trailing?: ReactNode; children: ReactNode }) => <section><h1>{title}</h1>{trailing}<p>{info}</p>{children}</section>,
  SettingsSelect: ({ label, value, options, onValueChange, disabled, error, hint }: { label: string; value: string; options: { value: string; label: string }[]; onValueChange: (value: string) => void; disabled?: boolean; error?: string; hint?: string }) => <label>{label}{!options.some(o => o.value === value) && <span>{value}</span>}<select aria-label={label} value={value} disabled={disabled} onChange={e => onValueChange(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select><span>{hint}{error}</span></label>,
  SettingsAction: ({ label, actionLabel, onPress, disabled, hint }: { label: string; actionLabel: string; onPress: () => void; disabled?: boolean; hint?: string }) => <div>{label}<p>{hint}</p><button disabled={disabled} onClick={onPress}>{actionLabel}</button></div>,
  SettingsRow: ({ label, hint }: { label: string; hint?: string }) => <div>{label}<p>{hint}</p></div>,
}));
vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Pressable: ({ children, onPress, disabled, accessibilityLabel }: { children: ReactNode; onPress: () => void; disabled?: boolean; accessibilityLabel?: string }) => <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{children}</button>,
}));

import contribute from "../index.client";
import { CuratorSettings } from "../client/settings";

const theme = { colors: {
  surface0: "#171b19", surface1: "#202421", surface2: "#272c29", border: "#303632",
  foreground: "#eeeeee", foregroundMuted: "#aaaaaa", accent: "#8fb996", accentForeground: "#171b19",
  statusSuccess: "#8fb996", statusWarning: "#e0b25c", statusDanger: "#d48471",
} };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(values: { fallbackProvider?: string; fallbackModel?: string } = {}) {
  const save = vi.fn();
  const entries = liveSnapshot.entries.filter(entry => ["omp", "claude", "codex", "hermes", "opencode"].includes(entry.provider));
  const providers = {
    waitForReady: vi.fn<RoutingProviders["waitForReady"]>(async () => routingSnapshot(entries)),
    listModels: vi.fn<RoutingProviders["listModels"]>(async provider => routingModels(provider, [{ id: "model-a", label: "Model A" }, { id: "vendor/model-b", label: "Model B" }])),
    listControls: vi.fn(routingControls),
    refresh: vi.fn(async () => ({})),
  };
  usePaseo.mockReturnValue({ providers });
  useSettings.mockReturnValue({ status: "ready", revision: "revision-1", values, saving: false, save });
  return { save, providers };
}

describe("routing settings UI", () => {
  it("shows usable choices, None default and transmission disclosure", async () => {
    const { save } = setup();
    contribute({ addTimelineRenderer: () => {}, addSettingsScreen: register } as never);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ Component: CuratorSettings }));
    render(<CuratorSettings theme={theme} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Claude" })).toBeTruthy());
    expect((screen.getByLabelText("Review provider") as HTMLSelectElement).value).toBe("");
    expect(screen.queryAllByRole("button", { name: "Unavailable" })).toHaveLength(0);
    expect(screen.getByText(/selected provider is used when the source review cannot run/i)).toBeTruthy();
    expect(screen.getByText(/bounded source turn.*skill index/)).toBeTruthy();
    expect(screen.getByText(/file contents and secrets/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Review provider"), { target: { value: "claude" } });
    expect(save).toHaveBeenCalledWith({ fallbackProvider: "claude" }, "revision-1");
  });
  it("preserves the selected provider and nested model across refresh, disappearance and discovery failure", async () => {
    const { save, providers } = setup({ fallbackProvider: "claude", fallbackModel: "vendor/model-b" });
    render(<CuratorSettings theme={theme} />);
    await waitFor(() => expect((screen.getByLabelText("Review model") as HTMLSelectElement).value).toBe("vendor/model-b"));
    providers.waitForReady.mockResolvedValue(routingSnapshot([]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));
    await screen.findByText(/Saved review provider is inactive/);
    expect(screen.queryByLabelText("Review model")).toBeNull();
    providers.waitForReady.mockRejectedValue(new Error("connection lost"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));
    await screen.findByText(/Provider discovery failed/);
    expect(screen.queryByRole("option", { name: /saved|claude/i })).toBeNull();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Review provider"), { target: { value: "" } });
    expect(save).toHaveBeenCalledWith({}, "revision-1");
  });
  it("saves explicit model changes and can clear fallback while discovery is pending", async () => {
    const { save } = setup({ fallbackProvider: "codex" });
    render(<CuratorSettings theme={theme} />);
    await screen.findByRole("option", { name: "Model B" });
    fireEvent.change(screen.getByLabelText("Review model"), { target: { value: "vendor/model-b" } });
    expect(save).toHaveBeenCalledWith({ fallbackProvider: "codex", fallbackModel: "vendor/model-b" }, "revision-1");
    fireEvent.change(screen.getByLabelText("Review provider"), { target: { value: "" } });
    expect(save).toHaveBeenLastCalledWith({}, "revision-1");
  });
  it("displays invalid settings and saving errors without silently resetting consent", () => {
    setup();
    useSettings.mockReturnValue({ status: "invalid", revision: "bad", error: "Invalid settings", reset: vi.fn() });
    render(<CuratorSettings theme={theme} />);
    expect(screen.getByText("Invalid settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset review settings" })).toBeTruthy();
  });
});


it("removes host-disabled providers from rows and selector on refresh without changing consent", async () => {
  const { providers, save } = setup({ fallbackProvider: "claude", fallbackModel: "vendor/model-b" });
  render(<CuratorSettings theme={theme} />);
  await screen.findByRole("option", { name: "Claude" });
  providers.waitForReady.mockResolvedValue(routingSnapshot(liveSnapshot.entries.map(e => e.provider === "claude" ? { ...e, enabled: false } : e)));
  fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));
  await waitFor(() => expect(screen.queryByRole("option", { name: /claude/i })).toBeNull());
  expect(screen.queryByText("Claude")).toBeNull();
  expect(screen.queryByText("Copilot")).toBeNull();
  expect(screen.queryByRole("option", { name: /copilot/i })).toBeNull();
  expect(screen.getByText(/Saved review provider is inactive/)).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Review provider"), { target: { value: "" } });
  expect(save).toHaveBeenCalledWith({}, "revision-1");
});

it("omits blocked names, policy reasons and the entire provider status list", async () => {
  setup();
  const { container } = render(<CuratorSettings theme={theme} />);
  await screen.findByRole("option", { name: "Claude" });
  expect(Array.from(screen.getByLabelText("Review provider").querySelectorAll("option"), o => o.textContent))
    .toEqual(["None", "Claude", "Codex", "OpenCode"]);
  for (const text of ["Oh My Pi", "Hermes", "Provider availability and safety", "Providers", "Loading providers", "review blocked",
    "Paseo exposes approval modes", "no verified native read-only", "escalation disabled", "MCP tools denied"]) {
    expect(container.textContent).not.toContain(text);
  }
  expect(container.textContent).not.toMatch(/fallback/i);
  expect(screen.getAllByRole("heading").map(h => h.textContent)).toEqual(["Curator routing"]);
  expect(screen.getByRole("button", { name: "Refresh providers" })).toBeTruthy();
  expect(container.querySelector("details")).toBeNull();
});

it("hides a saved blocked provider and its model without resetting consent", async () => {
  const { save, providers } = setup({ fallbackProvider: "claude", fallbackModel: "vendor/model-b" });
  providers.listControls.mockResolvedValue({ ...await routingControls({ provider: "claude/model-a", cwd: "." }), options: {} });
  const { container } = render(<CuratorSettings theme={theme} />);
  await screen.findByText(/Saved review provider is inactive/);
  expect(container.textContent).not.toMatch(/fallback/i);
  expect(Array.from(screen.getByLabelText("Review provider").querySelectorAll("option"), o => o.textContent)).toEqual(["None"]);
  expect(screen.queryByText("Claude")).toBeNull();
  expect(screen.queryByLabelText("Review model")).toBeNull();
  expect(screen.queryByText(/model-b/)).toBeNull();
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Review provider"), { target: { value: "" } });
  expect(save).toHaveBeenCalledWith({}, "revision-1");
});

it("offers only None while checking a saved route and lets None revoke immediately", () => {
  const { providers, save } = setup({ fallbackProvider: "hermes", fallbackModel: "private/model" });
  providers.waitForReady.mockReturnValue(new Promise(() => {}));
  const { container } = render(<CuratorSettings theme={theme} />);
  expect(container.textContent).not.toMatch(/fallback/i);
  expect(Array.from(screen.getByLabelText("Review provider").querySelectorAll("option"), o => o.textContent)).toEqual(["None"]);
  expect(screen.queryByLabelText("Review model")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Review provider"), { target: { value: "" } });
  expect(save).toHaveBeenCalledWith({}, "revision-1");
});

it("logs a fixed discovery failure without exposing the thrown error", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const { providers } = setup();
  providers.waitForReady.mockRejectedValue(new Error("PRIVATE-DISCOVERY-TOKEN"));
  render(<CuratorSettings theme={theme} />);
  await screen.findByText(/Provider discovery failed/);
  expect(log.mock.calls.flat().join(" ")).toContain("Provider discovery failed");
  expect(log.mock.calls.flat().join(" ")).not.toContain("PRIVATE-");
});

it("logs only bounded policy reasons, never host labels, models or raw failures", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const { providers } = setup();
  providers.waitForReady.mockResolvedValue(routingSnapshot([
    { provider: "omp", label: "PRIVATE-HOST-LABEL", enabled: true, status: "ready" },
    { provider: "claude", label: "PRIVATE-LABEL", enabled: true, status: "ready" },
  ]));
  providers.listModels.mockRejectedValue(new Error("PRIVATE-ERROR-TOKEN"));
  render(<CuratorSettings theme={theme} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh providers" }).hasAttribute("disabled")).toBe(false));
  expect(log.mock.calls.flat().join(" ")).toContain("Paseo exposes approval modes");
  expect(log.mock.calls.flat().join(" ")).toContain("Provider discovery failed; refresh to retry.");
  expect(log.mock.calls.flat().join(" ")).not.toContain("PRIVATE-");
});


it("clears stale ready rows and provider choices when refreshing an unreachable host", async () => {
  const { providers, save } = setup({ fallbackProvider: "claude" });
  render(<CuratorSettings theme={theme} />);
  await screen.findByRole("option", { name: "Claude" });
  providers.waitForReady.mockRejectedValue(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));
  await screen.findByText(/Provider discovery failed/);
  expect(screen.queryByRole("option", { name: "Claude" })).toBeNull();
  expect(screen.queryByText(/^Ready/)).toBeNull();
  expect(save).not.toHaveBeenCalled();
});


it("keeps refresh in the routing section without a provider row or diagnostic heading", async () => {
  setup();
  const { container } = render(<CuratorSettings theme={theme} />);
  expect(screen.queryByText(/^Loading providers$/)).toBeNull();
  await screen.findByRole("option", { name: "Claude" });
  expect(screen.queryByText(/^Providers$/)).toBeNull();
  expect(screen.getAllByRole("heading").map(h => h.textContent)).toEqual(["Curator routing"]);
  expect(screen.getByRole("button", { name: "Refresh providers" }).closest("section")).toBe(screen.getByRole("heading", { name: "Curator routing" }).closest("section"));
  expect(container.querySelector("details")).toBeNull();
});
