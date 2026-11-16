import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { CuratorActivityData } from "../shared/activity";

export function CuratorActivity({ item, theme }: PluginTimelineItemProps<CuratorActivityData>) {
  if (item.data.outcome === "applied") {
    const operationLabel =
      item.data.operationCount === 1 ? "1 change" : `${item.data.operationCount} changes`;
    const skillLabel =
      item.data.skillNames.length === 1 ? "1 skill" : `${item.data.skillNames.length} skills`;

    return (
      <View
        style={{
          gap: 6,
          borderWidth: 1,
          borderColor: theme.colors.statusSuccess,
          borderRadius: 10,
          padding: 12,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
          Curator updated skills
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {operationLabel} across {skillLabel}
        </Text>
        {item.data.skillNames.length > 0 ? (
          <Text style={{ color: theme.colors.foreground }}>{item.data.skillNames.join(", ")}</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={{
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        borderRadius: 10,
        padding: 12,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        Curator review failed
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        No skill changes were made. Check the curator audit log for details.
      </Text>
    </View>
  );
}
