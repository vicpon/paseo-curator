import { describe, expect, it } from "vitest";
import { MaintenanceRunner, type SkillTelemetry } from "../server/maintenance";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2040-02-01T00:00:00.000Z");

function telemetry(overrides: Partial<SkillTelemetry> = {}): SkillTelemetry {
  return {
    skillName: "learned-skill",
    createdBy: "paseo-curator",
    state: "active",
    lastActivityAt: new Date(NOW).toISOString(),
    viewCount: 0,
    useCount: 0,
    patchCount: 0,
    ...overrides,
  };
}

describe("MaintenanceRunner", () => {
  it("marks an inactive curator-created skill stale at 14 days without archiving", async () => {
    const rows = [telemetry({ lastActivityAt: new Date(NOW - 14 * DAY).toISOString() })];
    const transitions: Array<[string, string]> = [];
    const archives: string[] = [];
    const runner = new MaintenanceRunner({
      now: () => new Date(NOW),
      listTelemetry: () => rows,
      setState: (name, state) => { transitions.push([name, state]); },
      archiveSkill: async (name) => { archives.push(name); return "applied"; },
    });

    await runner.runOnce();

    expect(transitions).toEqual([["learned-skill", "stale"]]);
    expect(archives).toEqual([]);
  });

  it("archives a stale curator-created skill after 30 days and never deletes", async () => {
    const rows = [telemetry({ state: "stale", lastActivityAt: new Date(NOW - 30 * DAY).toISOString() })];
    const transitions: Array<[string, string]> = [];
    const operations: string[] = [];
    const runner = new MaintenanceRunner({
      now: () => new Date(NOW),
      listTelemetry: () => rows,
      setState: (name, state) => { transitions.push([name, state]); },
      archiveSkill: async (name) => { operations.push(`archive:${name}`); return "applied"; },
    });

    await runner.runOnce();

    expect(operations).toEqual(["archive:learned-skill"]);
    expect(transitions).toEqual([["learned-skill", "archived"]]);
    expect(operations.some((op) => op.startsWith("delete:"))).toBe(false);
  });

  it("never archives non-curator skills regardless of age", async () => {
    const rows = [telemetry({ createdBy: "user", state: "stale", lastActivityAt: new Date(NOW - 365 * DAY).toISOString() })];
    const transitions: Array<[string, string]> = [];
    const archives: string[] = [];
    const runner = new MaintenanceRunner({
      now: () => new Date(NOW),
      listTelemetry: () => rows,
      setState: (name, state) => { transitions.push([name, state]); },
      archiveSkill: async (name) => { archives.push(name); return "applied"; },
    });

    await runner.runOnce();

    expect(archives).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("excludes overlapping maintenance timer runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = new MaintenanceRunner({
      now: () => new Date(NOW),
      listTelemetry: () => [telemetry({ state: "stale", lastActivityAt: new Date(NOW - 30 * DAY).toISOString() })],
      setState: () => {},
      archiveSkill: async () => { await gate; return "applied"; },
    });

    const first = runner.runOnce();
    expect(await runner.runOnce()).toBe("overlap");
    release();
    expect(await first).toBe("ran");
  });

  it("does not mark archived when guarded archive is rejected", async () => {
    const rows = [telemetry({ state: "stale", lastActivityAt: new Date(NOW - 30 * DAY).toISOString() })];
    const transitions: Array<[string, string]> = [];
    const runner = new MaintenanceRunner({
      now: () => new Date(NOW),
      listTelemetry: () => rows,
      setState: (name, state) => { transitions.push([name, state]); },
      archiveSkill: async () => "rejected",
    });

    await runner.runOnce();

    expect(transitions).toEqual([]);
  });
});
