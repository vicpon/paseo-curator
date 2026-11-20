import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CuratorSettings } from "./client/settings";
import { CuratorActivity } from "./client/activity";
import { curatorActivityDataSchema } from "./shared/activity";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "curator", title: "Curator", icon: "Settings", Component: CuratorSettings });
  client.addTimelineRenderer({
    kind: "curator-activity",
    version: 1,
    schema: curatorActivityDataSchema,
    Component: CuratorActivity,
  });
  return () => {};
}
