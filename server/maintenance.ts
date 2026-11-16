export type SkillLifecycleState = "active" | "stale" | "archived";

export interface SkillTelemetry {
  skillName: string;
  createdBy: string;
  state: SkillLifecycleState;
  lastActivityAt: string;
  viewCount: number;
  useCount: number;
  patchCount: number;
}

export interface MaintenanceOptions {
  now?: () => Date;
  staleAfterMs?: number;
  archiveAfterMs?: number;
  listTelemetry: () => SkillTelemetry[];
  setState: (skillName: string, state: SkillLifecycleState) => void;
  archiveSkill: (skillName: string) => Promise<"applied" | "rejected">;
}

const DAY = 24 * 60 * 60 * 1_000;

/** Deterministic, model-free skill lifecycle maintenance. Never deletes. */
export class MaintenanceRunner {
  private readonly now: () => Date;
  private readonly staleAfterMs: number;
  private readonly archiveAfterMs: number;
  private active: Promise<"ran"> | null = null;

  constructor(private readonly options: MaintenanceOptions) {
    this.now = options.now ?? (() => new Date());
    this.staleAfterMs = options.staleAfterMs ?? 14 * DAY;
    this.archiveAfterMs = options.archiveAfterMs ?? 30 * DAY;
  }

  runOnce(): Promise<"ran" | "overlap"> {
    if (this.active !== null) return Promise.resolve("overlap");
    const run = this.run().finally(() => {
      if (this.active === run) this.active = null;
    });
    this.active = run;
    return run;
  }

  async shutdown(): Promise<void> {
    await (this.active ?? Promise.resolve());
  }

  private async run(): Promise<"ran"> {
    const now = this.now().getTime();
    for (const skill of this.options.listTelemetry()) {
      if (skill.createdBy !== "paseo-curator" || skill.state === "archived") continue;
      const inactiveMs = now - Date.parse(skill.lastActivityAt);
      if (!Number.isFinite(inactiveMs) || inactiveMs < 0) continue;
      if (skill.state === "stale" && inactiveMs >= this.archiveAfterMs) {
        const outcome = await this.options.archiveSkill(skill.skillName);
        if (outcome === "applied") this.options.setState(skill.skillName, "archived");
      } else if (skill.state === "active" && inactiveMs >= this.staleAfterMs) {
        this.options.setState(skill.skillName, "stale");
      }
    }
    return "ran";
  }
}
