import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const curatorSettings = defineSettings({
  id: "curator",
  scope: "host",
  version: 1,
  schema: z.object({
    fallbackProvider: z.enum(["codex"]).optional(),
  }).strict(),
});
