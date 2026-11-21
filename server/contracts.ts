import { z } from "zod";

/**
 * Domain contracts for the Paseo Curator plugin.
 *
 * These are the shared, schema-validated types that every other module
 * consumes. They are the single source of truth for the shapes that flow
 * between the durable queue, the skill manager, the review prompt/submission tool,
 * the lifecycle orchestrator, and the maintenance pass.
 *
 * All schemas are strict (no unknown keys) because model output is untrusted
 * input and must not smuggle extra fields into persisted state.
 */

// ---------------------------------------------------------------------------
// Skill name
// ---------------------------------------------------------------------------

/**
 * A valid skill name: a non-empty slug of alphanumerics and hyphens.
 * Must not contain path separators, leading dots, or whitespace, so it can
 * never be used to traverse out of the skill root when joined as a path.
 */
export const skillNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i, "skillName must be a slug of alphanumerics and hyphens");

// ---------------------------------------------------------------------------
// SkillOperation
// ---------------------------------------------------------------------------

/**
 * Support-file subdirectories that a curator may write or remove. SKILL.md is
 * the one additional top-level path allowed for `patch`. Everything else is
 * rejected at the contract level.
 */
export const SUPPORT_FILE_DIRS = [
  "references",
  "templates",
  "scripts",
  "assets",
] as const;

export type SupportFileDir = (typeof SUPPORT_FILE_DIRS)[number];

/** A relative path inside a skill. Rejects traversal, absolute, and empty paths. */
const relativePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/"), "path must be relative")
  .refine((p) => !p.startsWith("\\"), "path must be relative")
  .refine((p) => !p.split(/[\\/]/).includes(".."), "path must not contain traversal segments")
  .refine((p) => p.split(/[\\/]/).every((seg) => seg.length > 0), "path must not contain empty segments");

/**
 * The top-level path a `patch` may target. Either `SKILL.md` or a support file
 * under one of the supported directories.
 */
const patchTargetPathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.startsWith("\\"), "path must be relative")
  .refine((p) => !p.split(/[\\/]/).includes(".."), "path must not contain traversal segments")
  .refine((p) => {
    if (p === "SKILL.md") return true;
    const segments = p.split(/[\\/]/);
    if (segments.length < 2) return false;
    const dir = segments[0].toLowerCase();
    return (SUPPORT_FILE_DIRS as readonly string[]).includes(dir) && segments.every((s) => s.length > 0);
  }, "patch path must be SKILL.md or a supported support file");

/**
 * A support-file path for `write_file`/`remove_file`: strictly one of the
 * supported directories at the top level, non-empty.
 */
const supportFilePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.startsWith("\\"), "path must be relative")
  .refine((p) => !p.split(/[\\/]/).includes(".."), "path must not contain traversal segments")
  .refine((p) => {
    const segments = p.split(/[\\/]/);
    if (segments.length < 2) return false;
    const dir = segments[0].toLowerCase();
    return (SUPPORT_FILE_DIRS as readonly string[]).includes(dir) && segments.every((s) => s.length > 0);
  }, "path must be under one of references/, templates/, scripts/, or assets/");

/** A curator-produced skill mutation. At most 20 may appear in one review. */
export const SkillOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("create"),
      skillName: skillNameSchema,
      /** Full SKILL.md content, including YAML frontmatter. */
      content: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("patch"),
      skillName: skillNameSchema,
      path: patchTargetPathSchema,
      oldText: z.string().min(1, "oldText must be non-empty and unique"),
      newText: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("write_file"),
      skillName: skillNameSchema,
      path: supportFilePathSchema,
      content: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("remove_file"),
      skillName: skillNameSchema,
      path: supportFilePathSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("archive"),
      skillName: skillNameSchema,
    })
    .strict(),
]);

export type SkillOperation = z.infer<typeof SkillOperationSchema>;

// ---------------------------------------------------------------------------
// SkillManifest
// ---------------------------------------------------------------------------

/**
 * Provenance and lifecycle metadata for a single skill. `createdBy` is the
 * only field the maintenance pass uses to decide whether a skill is eligible
 * for the automatic lifecycle sweep (`created_by: paseo-curator`).
 */
export const SkillManifestSchema = z
  .object({
    skillName: skillNameSchema,
    createdAt: z.string().min(1),
    /** `paseo-curator` for agent-created skills; anything else is user-owned. */
    createdBy: z.string().min(1),
  })
  .strict();

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ---------------------------------------------------------------------------
// ReviewResult
// ---------------------------------------------------------------------------

/** Outcome of a single curator review of a completed source turn. */
export const ReviewOutcomeSchema = z.enum(["saved", "nothing_to_save"]);
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

/** The structured arguments a curator submits for a queued review. */
export const ReviewResultSchema = z
  .object({
    summary: z.string().min(1),
    outcome: ReviewOutcomeSchema,
    /** At most MAX_OPERATIONS; empty when outcome is nothing_to_save. */
    operations: z.array(SkillOperationSchema).max(20),
  })
  .strict();

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** Maximum number of operations in a single review batch. */
export const MAX_OPERATIONS = 20;

// ---------------------------------------------------------------------------
// QueueRecord
// ---------------------------------------------------------------------------

/** Queue lifecycle states. `nothing_to_save` is a terminal success state. */
export const QueueStatusSchema = z.enum([
  "pending",
  "running",
  "applied",
  "nothing_to_save",
  "failed",
]);
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

/**
 * A durable row in the review queue, keyed by (sourceAgentId, turnId).
 * Optional timestamps reflect the current lifecycle stage; `error` is present
 * only for terminal `failed` rows.
 */
export const QueueRecordSchema = z
  .object({
    id: z.string().min(1),
    sourceAgentId: z.string().min(1),
    turnId: z.string().min(1),
    status: QueueStatusSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    attempts: z.number().int().min(0),
    startedAt: z.string().min(1).optional(),
    completedAt: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .strict()
  .refine((r) => {
    // `error` is only meaningful on a failed row.
    if (r.status === "failed") return r.error !== undefined;
    return true;
  }, { message: "error is only allowed when status is 'failed'" });

export type QueueRecord = z.infer<typeof QueueRecordSchema>;

// ---------------------------------------------------------------------------
// AuditRecord
// ---------------------------------------------------------------------------

/** The result of the skill manager applying (or rejecting) one batch. */
export const AuditOutcomeSchema = z.enum(["applied", "rejected", "nothing_to_save"]);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/**
 * One immutable ledger entry recording that a review batch was applied or
 * rejected, with a hash of the operations so duplicates can be detected.
 */
export const AuditRecordSchema = z
  .object({
    id: z.string().min(1),
    queueId: z.string().min(1),
    sourceAgentId: z.string().min(1),
    turnId: z.string().min(1),
    outcome: AuditOutcomeSchema,
    timestamp: z.string().min(1),
    summary: z.string().min(1),
    operationCount: z.number().int().min(0),
    operationsHash: z.string().regex(/^[a-f0-9]{64}$/),
    skillNames: z.array(skillNameSchema),
    /** Present only when outcome is 'rejected'. */
    rejectionReason: z.string().min(1).optional(),
  })
  .strict()
  .refine((r) => {
    // A rejection must carry a reason; an application must not.
    if (r.outcome === "rejected") return r.rejectionReason !== undefined;
    return r.rejectionReason === undefined;
  }, { message: "rejectionReason is only allowed when outcome is 'rejected'" });

export type AuditRecord = z.infer<typeof AuditRecordSchema>;

// ---------------------------------------------------------------------------
// PluginConfig
// ---------------------------------------------------------------------------

/**
 * Operator-tunable plugin configuration. Defaults match the design: a review
 * after 10 accumulated tool iterations, one curator at a time, a 20-operation
 * batch cap, deterministic maintenance on, consolidation off, 14-day stale,
 * 30-day archive.
 */
export const PluginConfigSchema = z
  .object({
    skillRoot: z.string().min(1),
    reviewThreshold: z.number().int().min(1),
    curatorConcurrency: z.number().int().min(1),
    maxOperations: z.number().int().min(1).max(20),
    maintenanceEnabled: z.boolean().default(true),
    consolidationEnabled: z.boolean().default(false),
    staleDays: z.number().int().min(1).default(14),
    archiveDays: z.number().int().min(1).default(30),
    maxRetries: z.number().int().min(0).default(3),
  })
  .strict()
  .refine((c) => c.archiveDays >= c.staleDays, {
    message: "archiveDays must be >= staleDays",
  })
  .refine((c) => !c.consolidationEnabled || c.maintenanceEnabled, {
    message: "consolidationEnabled requires maintenanceEnabled",
  })
  .default({
    skillRoot: "~/.agents/skills",
    reviewThreshold: 10,
    curatorConcurrency: 1,
    maxOperations: 20,
    maintenanceEnabled: true,
    consolidationEnabled: false,
    staleDays: 14,
    archiveDays: 30,
    maxRetries: 3,
  });

export type PluginConfig = z.infer<typeof PluginConfigSchema>;
