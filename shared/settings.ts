import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const routingSettingsSchema = z.object({
  fallbackProvider: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
  fallbackModel: z.string().min(1).max(512).regex(/^\S+$/).optional(),
}).strict().refine(values => values.fallbackModel === undefined || values.fallbackProvider !== undefined);

export const curatorSettings = defineSettings({
  id: "curator",
  scope: "host",
  version: 2,
  schema: routingSettingsSchema,
  migrate(values, fromVersion) {
    // V1 accepted only explicit Codex consent. Invalid legacy data never grants consent.
    const legacy = z.object({ fallbackProvider: z.literal("codex").optional() }).strict().safeParse(values);
    return fromVersion === 1 && legacy.success ? legacy.data : {};
  },
});
