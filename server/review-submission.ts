import { z } from "zod";
import type { AgentToolResult } from "@getpaseo/plugin/server";
import { ReviewResultSchema } from "./contracts";

export const SUBMISSION_TOOL_NAME = "submit_review";
export const MAX_SUBMISSIONS = 4;
export const REVIEW_TIMEOUT_MS = 300_000;
export type SubmissionHandler = (input: unknown, authorized: () => Promise<boolean>) => Promise<AgentToolResult>;

export const SubmissionSchema = ReviewResultSchema.extend({ summary: z.string().min(1).max(2000) })
  .superRefine((value, ctx) => {
    if ((value.outcome === "nothing_to_save") !== (value.operations.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["operations"], message: "outcome must agree with operations" });
    }
    if (value.operations.some(op => op.type === "archive")) {
      ctx.addIssue({ code: "custom", path: ["operations"], message: "archive is maintenance only" });
    }
  });

function schemaFeedback(error: { issues: ReadonlyArray<{ path: readonly PropertyKey[]; code: string }> }): string {
  // Never echo issue messages, unknown keys, or values from the model.
  const fields = new Set(["summary", "outcome", "operations", "type", "skillName", "path", "oldText", "newText", "content"]);
  const issues = error.issues.slice(0, 4).map(issue => {
    const path = issue.path.filter(part => typeof part === "number" || fields.has(String(part))).join("/");
    return `${path || "submission"}: ${issue.code}`;
  });
  return `schema validation failed (${issues.join("; ")}). Use only summary, outcome, operations; saved requires 1-20 operations; nothing_to_save requires []; archive is maintenance only. Follow the tool schema.`;
}

// The host's MCP bridge rebuilds a Zod schema from this transport envelope.
// Keep it permissive so invalid object arguments reach our counted, value-free
// validation callback instead of escaping through host-side schema errors.
export const SubmissionToolInput = z.object({
  summary: z.unknown().optional().describe("Required: a nonempty summary string, at most 2000 characters."),
  outcome: z.unknown().optional().describe("Required: saved or nothing_to_save. nothing_to_save requires operations []."),
  operations: z.unknown().optional().describe("Required: an array of 1-20 strict skill operations for saved, or [] for nothing_to_save. See the argument contract in the tool description."),
}).passthrough();
export const SubmissionArgumentContract = JSON.stringify(z.toJSONSchema(SubmissionSchema));

export function validateSubmission(input: unknown):
  | { ok: true; value: z.infer<typeof SubmissionSchema> }
  | { ok: false; feedback: string } {
  // Bound payload processing independently of provider token limits.
  try {
    if (JSON.stringify(input)?.length > 256_000) return { ok: false, feedback: "submission exceeds 256000 characters" };
  } catch { return { ok: false, feedback: "submission must be JSON arguments" }; }
  const parsed = SubmissionSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, feedback: schemaFeedback(parsed.error) };
}

export function submissionError(text: string): AgentToolResult {
  return { isError: true, text, structuredContent: { accepted: false } };
}

export function managerFeedback(reason?: string): string {
  if (reason?.includes("oldText not found")) return "oldText not found: copy exact text from the pre-review snapshot.";
  if (reason?.includes("oldText is not unique")) return "oldText is not unique: include more surrounding text from the snapshot.";
  if (reason?.includes("changed since review")) return "skill changed since review; do not overwrite newer content.";
  if (reason?.includes("already exists")) return "target already exists; patch the existing snapshot instead of creating it.";
  if (reason?.includes("does not exist")) return "target does not exist; check the snapshot's skill and path.";
  if (reason?.includes("frontmatter") || reason?.includes("name:")) return "invalid skill frontmatter; preserve name, description and provenance rules.";
  return "guarded manager rejected the batch; check exact text, paths, frontmatter and snapshot freshness. No successful submission was recorded.";
}
