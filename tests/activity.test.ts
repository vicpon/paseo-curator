import { describe, expect, it } from "vitest";

import { appendCuratorActivity } from "../server/activity";
import type { CuratorActivityNotification } from "../server/orchestrator";

class FakePaseo {
  readonly appended: Array<{ agentId: string; item: unknown }> = [];
  readonly agents = {
    ref: (agentId: string) => ({
      timeline: {
        append: async (item: unknown) => {
          this.appended.push({ agentId, item });
          return { seq: this.appended.length, epoch: "test" };
        },
      },
    }),
  };
}

describe("curator activity timeline items", () => {
  it("appends an applied result to the source agent timeline", async () => {
    const paseo = new FakePaseo();
    const notification: CuratorActivityNotification = {
      outcome: "applied",
      sourceAgentId: "source-agent",
      turnId: "turn-7",
      operationCount: 2,
      skillNames: ["deploy", "testing"],
    };

    await appendCuratorActivity(paseo, notification);

    expect(paseo.appended).toEqual([
      {
        agentId: "source-agent",
        item: {
          type: "plugin",
          id: "curator-turn-7-applied",
          kind: "curator-activity",
          version: 1,
          data: {
            outcome: "applied",
            operationCount: 2,
            skillNames: ["deploy", "testing"],
          },
        },
      },
    ]);
  });

  it("appends a content-free terminal failure", async () => {
    const paseo = new FakePaseo();

    await appendCuratorActivity(paseo, {
      outcome: "failed",
      sourceAgentId: "source-agent",
      turnId: "turn-secret",
    });

    expect(paseo.appended[0]).toEqual({
      agentId: "source-agent",
      item: {
        type: "plugin",
        id: "curator-turn-secret-failed",
        kind: "curator-activity",
        version: 1,
        data: { outcome: "failed" },
      },
    });
  });
});
