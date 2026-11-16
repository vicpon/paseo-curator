import type { CuratorActivityNotification } from "./orchestrator";

interface TimelineAppender {
  agents: {
    ref(agentId: string): {
      timeline: {
        append(item: {
          type: "plugin";
          id: string;
          kind: string;
          version: number;
          data: unknown;
        }): Promise<unknown>;
      };
    };
  };
}

/** Append a terminal curator result to the source agent's visible timeline. */
export async function appendCuratorActivity(
  paseo: TimelineAppender,
  notification: CuratorActivityNotification,
): Promise<void> {
  const data =
    notification.outcome === "applied"
      ? {
          outcome: "applied" as const,
          operationCount: notification.operationCount,
          skillNames: notification.skillNames,
        }
      : { outcome: "failed" as const };

  await paseo.agents.ref(notification.sourceAgentId).timeline.append({
    type: "plugin",
    id: `curator-${notification.turnId}-${notification.outcome}`,
    kind: "curator-activity",
    version: 1,
    data,
  });
}
