import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import type { CuratorActivityData } from "../shared/activity";

/**
 * Compact, subtext-style rendering: a single muted line, like Hermes'
 * self-improvement notice. No box, no border — the activity is informational,
 * not a message that demands attention.
 */
export function CuratorActivity({ item, theme }: PluginTimelineItemProps<CuratorActivityData>) {
  if (item.data.outcome === "applied") {
    const skills = item.data.skillNames.length > 0 ? item.data.skillNames.join(", ") : "skills";
    return (
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingVertical: 2 }}>
        Self-improvement review — updated {skills}
        {item.data.operationCount > 1 ? ` (${item.data.operationCount} changes)` : ""}
      </Text>
    );
  }

  return (
    <Text style={{ color: theme.colors.statusDanger, fontSize: 12, paddingVertical: 2 }}>
      Curator review failed — no changes made (see curator audit log)
    </Text>
  );
}
