import type { SourceAgent } from "./paseo-adapter";

export interface RecoveredTurn {
  agent: SourceAgent;
  turnId: string;
  cursor: string;
}

export interface ReconciliationOptions {
  getCursor: () => string | null;
  setCursor: (cursor: string) => void;
  hasTurn: (agentId: string, turnId: string) => boolean;
  discover: (after: string | null) => Promise<{ cursor: string; turns: RecoveredTurn[] }>;
  handleTurn: (agent: SourceAgent, turnId: string) => Promise<unknown>;
}

/** Bounded, single-flight recovery for completed turns missed by live hooks. */
export class ReconciliationRunner {
  private active: Promise<"ran"> | null = null;

  constructor(private readonly options: ReconciliationOptions) {}

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
    const page = await this.options.discover(this.options.getCursor());
    for (const recovered of page.turns) {
      if (this.options.hasTurn(recovered.agent.id, recovered.turnId)) continue;
      await this.options.handleTurn(recovered.agent, recovered.turnId);
    }
    this.options.setCursor(page.cursor);
    return "ran";
  }
}
