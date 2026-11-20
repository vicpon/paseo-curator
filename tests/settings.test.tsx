import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const { useSettings, register } = vi.hoisted(() => ({ useSettings: vi.fn(), register: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SettingsSection: "section", SettingsSelect: "select", SettingsAction: "action" }));
vi.mock("react-native", () => ({ Text: "text" }));

import contribute from "../index.client";
import { CuratorSettings } from "../client/settings";
import { curatorSettings } from "../shared/settings";

interface SelectProps {
  label: string;
  value: string;
  onValueChange(value: string): void;
}

describe("routing settings", () => {
  it("registers a user-editable settings screen and saves or clears fallback with the displayed revision", () => {
    contribute({ addTimelineRenderer: () => {}, addSettingsScreen: register } as never);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ Component: CuratorSettings }));
    const save = vi.fn();
    useSettings.mockReturnValue({ status: "ready", revision: "revision-1", values: {}, saving: false, save });
    const view = CuratorSettings() as ReactElement<{ children: ReactElement | ReactElement[] }>;
    const select = [view.props.children].flat().find(child => child?.props && (child.props as SelectProps).label === "Fallback provider") as ReactElement<SelectProps>;
    expect(select.props.value).toBe("");
    select.props.onValueChange("codex");
    select.props.onValueChange("");
    expect(save.mock.calls).toEqual([[{ fallbackProvider: "codex" }, "revision-1"], [{}, "revision-1"]]);
  });

  it("rejects unavailable or unknown fallback policies rather than accepting arbitrary providers", () => {
    expect(curatorSettings.schema.safeParse({ fallbackProvider: "codex" }).success).toBe(true);
    expect(curatorSettings.schema.safeParse({ fallbackProvider: "omp" }).success).toBe(false);
  });
});
