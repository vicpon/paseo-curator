import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CuratorActivity } from "./client/activity";
import { curatorActivityDataSchema } from "./shared/activity";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "curator-activity",
    version: 1,
    schema: curatorActivityDataSchema,
    Component: CuratorActivity,
  });
  return () => {};
}
