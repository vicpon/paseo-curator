import { z } from "zod";

export const curatorActivityDataSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("applied"),
    operationCount: z.number().int().nonnegative(),
    skillNames: z.array(z.string()),
  }),
  z.object({
    outcome: z.literal("failed"),
  }),
]);

export type CuratorActivityData = z.output<typeof curatorActivityDataSchema>;
