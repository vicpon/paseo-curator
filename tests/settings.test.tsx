import { liveSnapshot, routingSnapshot, routingModels, routingControls } from "./routing-fixtures";
import type { RoutingProviders } from "../shared/routing";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const { useSettings, usePaseo, register } = vi.hoisted(() => ({ useSettings: vi.fn(), usePaseo: vi.fn(), register: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings, usePaseo }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsSection: ({ title, info, children }: { title: string; info: string; children: ReactNode }) => <section><h1>{title}</h1><p>{info}</p>{children}</section>,
  SettingsSelect: ({ label, value, options, onValueChange, disabled, error, hint }: { label: string; value: string; options: { value: string; label: string }[]; onValueChange: (value: string) => void; disabled?: boolean; error?: string; hint?: string }) => <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={e => onValueChange(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select><span>{hint}{error}</span></label>,
  SettingsAction: ({ label, actionLabel, onPress, disabled, hint }: { label: string; actionLabel: string; onPress: () => void; disabled?: boolean; hint?: string }) => <div>{label}<p>{hint}</p><button disabled={disabled} onClick={onPress}>{actionLabel}</button></div>,
  SettingsRow: ({ label, hint }: { label: string; hint?: string }) => <div>{label}<p>{hint}</p></div>,
}));
vi.mock("react-native", () => ({ Text: "text" }));

import contribute from "../index.client";
import { CuratorSettings } from "../client/settings";

afterEach(cleanup);
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
  it("shows discovered families, None default, truthful disabled safety status and transmission disclosure", async () => {
    const { save } = setup();
    contribute({ addTimelineRenderer: () => {}, addSettingsScreen: register } as never);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ Component: CuratorSettings }));
    render(<CuratorSettings />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Claude" })).toBeTruthy());
    expect((screen.getByLabelText("Fallback provider") as HTMLSelectElement).value).toBe("");
    expect(screen.getAllByRole("button", { name: "Unavailable" })).toHaveLength(3);
    expect(screen.getByText(/source turn.*skill index.*selected provider/i)).toBeTruthy();
    expect(screen.getByText(/file contents and secrets/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Fallback provider"), { target: { value: "claude" } });
    expect(save).toHaveBeenCalledWith({ fallbackProvider: "claude" }, "revision-1");
  });
  it("preserves the selected provider and nested model across refresh, disappearance and discovery failure", async () => {
    const { save, providers } = setup({ fallbackProvider: "claude", fallbackModel: "vendor/model-b" });
    render(<CuratorSettings />);
    await waitFor(() => expect((screen.getByLabelText("Fallback model") as HTMLSelectElement).value).toBe("vendor/model-b"));
    providers.waitForReady.mockResolvedValue(routingSnapshot([]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /claude.*unavailable/ })).toBeTruthy());
    expect((screen.getByLabelText("Fallback model") as HTMLSelectElement).value).toBe("vendor/model-b");
    providers.waitForReady.mockRejectedValue(new Error("connection lost"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));
    await screen.findByText(/Provider discovery failed/);
    expect((screen.getByLabelText("Fallback provider") as HTMLSelectElement).value).toBe("claude");
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Fallback provider"), { target: { value: "" } });
    expect(save).toHaveBeenCalledWith({}, "revision-1");
  });
  it("saves explicit model changes and can clear fallback while discovery is pending", async () => {
    const { save } = setup({ fallbackProvider: "codex" });
    render(<CuratorSettings />);
    await screen.findByRole("option", { name: "Model B" });
    fireEvent.change(screen.getByLabelText("Fallback model"), { target: { value: "vendor/model-b" } });
    expect(save).toHaveBeenCalledWith({ fallbackProvider: "codex", fallbackModel: "vendor/model-b" }, "revision-1");
    fireEvent.change(screen.getByLabelText("Fallback provider"), { target: { value: "" } });
    expect(save).toHaveBeenLastCalledWith({}, "revision-1");
  });
  it("displays invalid settings and saving errors without silently resetting consent", () => {
    setup();
    useSettings.mockReturnValue({ status: "invalid", revision: "bad", error: "Invalid settings", reset: vi.fn() });
    render(<CuratorSettings />);
    expect(screen.getByText("Invalid settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset fallback" })).toBeTruthy();
  });
});
