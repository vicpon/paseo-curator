import { describe, expect, it } from "vitest";

import {
  QueueRecordSchema,
  ReviewResultSchema,
  SkillManifestSchema,
  SkillOperationSchema,
  AuditRecordSchema,
  PluginConfigSchema,
} from "../server/contracts";

describe("contracts", () => {
  describe("QueueRecord", () => {
    it("accepts a valid pending queue record", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        status: "pending",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        attempts: 0,
      };
      expect(() => QueueRecordSchema.parse(record)).not.toThrow();
    });

    it("accepts a running queue record", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        status: "running",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:01:00.000Z",
        attempts: 1,
        startedAt: "2026-11-15T00:01:00.000Z",
      };
      expect(() => QueueRecordSchema.parse(record)).not.toThrow();
    });

    it("accepts an applied queue record", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        status: "applied",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:02:00.000Z",
        attempts: 1,
        completedAt: "2026-11-15T00:02:00.000Z",
      };
      expect(() => QueueRecordSchema.parse(record)).not.toThrow();
    });

    it("accepts a nothing_to_save queue record", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        status: "nothing_to_save",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:02:00.000Z",
        attempts: 1,
        completedAt: "2026-11-15T00:02:00.000Z",
      };
      expect(() => QueueRecordSchema.parse(record)).not.toThrow();
    });

    it("accepts a failed queue record with an error", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        status: "failed",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:02:00.000Z",
        attempts: 3,
        error: "curator agent crashed",
      };
      expect(() => QueueRecordSchema.parse(record)).not.toThrow();
    });

    it("rejects an unknown status", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        status: "weird",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        attempts: 0,
      };
      expect(() => QueueRecordSchema.parse(record)).toThrow();
    });

    it("rejects an unknown key", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        status: "pending",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        attempts: 0,
        surpriseKey: "nope",
      };
      expect(() => QueueRecordSchema.parse(record)).toThrow();
    });

    it("requires a non-empty sourceAgentId", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "",
        turnId: "turn-001",
        status: "pending",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        attempts: 0,
      };
      expect(() => QueueRecordSchema.parse(record)).toThrow();
    });

    it("requires a non-empty turnId", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "",
        status: "pending",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        attempts: 0,
      };
      expect(() => QueueRecordSchema.parse(record)).toThrow();
    });

    it("requires non-negative attempts", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        status: "pending",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        attempts: -1,
      };
      expect(() => QueueRecordSchema.parse(record)).toThrow();
    });

    it("requires a non-negative integer attempts", () => {
      const record = {
        id: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        status: "pending",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        attempts: 1.5,
      };
      expect(() => QueueRecordSchema.parse(record)).toThrow();
    });
  });

  describe("SkillOperation", () => {
    it("accepts a valid create operation", () => {
      const op = {
        type: "create",
        skillName: "fixing-flaky-tests",
        content: "---\nname: fixing-flaky-tests\ndescription: How to fix flaky tests.\n---\n\n# Body",
      };
      expect(() => SkillOperationSchema.parse(op)).not.toThrow();
    });

    it("accepts a valid patch operation", () => {
      const op = {
        type: "patch",
        skillName: "fixing-flaky-tests",
        path: "SKILL.md",
        oldText: "Step 1: original",
        newText: "Step 1: improved",
      };
      expect(() => SkillOperationSchema.parse(op)).not.toThrow();
    });

    it("accepts a valid write_file operation for a supported path", () => {
      const op = {
        type: "write_file",
        skillName: "fixing-flaky-tests",
        path: "references/details.md",
        content: "reference content",
      };
      expect(() => SkillOperationSchema.parse(op)).not.toThrow();
    });

    it("accepts a valid remove_file operation", () => {
      const op = {
        type: "remove_file",
        skillName: "fixing-flaky-tests",
        path: "references/details.md",
      };
      expect(() => SkillOperationSchema.parse(op)).not.toThrow();
    });

    it("accepts a valid archive operation", () => {
      const op = {
        type: "archive",
        skillName: "fixing-flaky-tests",
      };
      expect(() => SkillOperationSchema.parse(op)).not.toThrow();
    });

    it("rejects an unknown operation type", () => {
      const op = {
        type: "delete_everything",
        skillName: "fixing-flaky-tests",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects a malformed skill name with a slash", () => {
      const op = {
        type: "create",
        skillName: "../escape",
        content: "content",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects a malformed skill name with a space", () => {
      const op = {
        type: "create",
        skillName: "bad name",
        content: "content",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects a malformed skill name with a dot at the start", () => {
      const op = {
        type: "create",
        skillName: ".hidden",
        content: "content",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects an empty skill name", () => {
      const op = {
        type: "create",
        skillName: "",
        content: "content",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects an unsupported support-file path for write_file", () => {
      const op = {
        type: "write_file",
        skillName: "fixing-flaky-tests",
        path: "arbitrary/path.md",
        content: "content",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects a traversal path for write_file", () => {
      const op = {
        type: "write_file",
        skillName: "fixing-flaky-tests",
        path: "../../etc/passwd",
        content: "content",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects an absolute path for write_file", () => {
      const op = {
        type: "write_file",
        skillName: "fixing-flaky-tests",
        path: "/etc/passwd",
        content: "content",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects an unsupported support-file path for remove_file", () => {
      const op = {
        type: "remove_file",
        skillName: "fixing-flaky-tests",
        path: "arbitrary/path.md",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects a patch with a traversal path", () => {
      const op = {
        type: "patch",
        skillName: "fixing-flaky-tests",
        path: "../escape.md",
        oldText: "a",
        newText: "b",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects a patch with an absolute path", () => {
      const op = {
        type: "patch",
        skillName: "fixing-flaky-tests",
        path: "/etc/passwd",
        oldText: "a",
        newText: "b",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("requires content for a create operation", () => {
      const op = {
        type: "create",
        skillName: "fixing-flaky-tests",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("requires a unique oldText for a patch operation", () => {
      const op = {
        type: "patch",
        skillName: "fixing-flaky-tests",
        path: "SKILL.md",
        oldText: "",
        newText: "b",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects an unknown key in a create operation", () => {
      const op = {
        type: "create",
        skillName: "fixing-flaky-tests",
        content: "content",
        surprise: "nope",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("rejects an unknown key in a patch operation", () => {
      const op = {
        type: "patch",
        skillName: "fixing-flaky-tests",
        path: "SKILL.md",
        oldText: "a",
        newText: "b",
        surprise: "nope",
      };
      expect(() => SkillOperationSchema.parse(op)).toThrow();
    });

    it("accepts an empty path for a patch targeting SKILL.md", () => {
      const op = {
        type: "patch",
        skillName: "fixing-flaky-tests",
        path: "SKILL.md",
        oldText: "a",
        newText: "b",
      };
      expect(() => SkillOperationSchema.parse(op)).not.toThrow();
    });
  });

  describe("SkillManifest", () => {
    it("accepts a valid manifest", () => {
      const manifest = {
        skillName: "fixing-flaky-tests",
        createdAt: "2026-11-15T00:00:00.000Z",
        createdBy: "paseo-curator",
      };
      expect(() => SkillManifestSchema.parse(manifest)).not.toThrow();
    });

    it("rejects a malformed skill name", () => {
      const manifest = {
        skillName: "../escape",
        createdAt: "2026-11-15T00:00:00.000Z",
        createdBy: "paseo-curator",
      };
      expect(() => SkillManifestSchema.parse(manifest)).toThrow();
    });

    it("rejects an unknown key", () => {
      const manifest = {
        skillName: "fixing-flaky-tests",
        createdAt: "2026-11-15T00:00:00.000Z",
        createdBy: "paseo-curator",
        surprise: "nope",
      };
      expect(() => SkillManifestSchema.parse(manifest)).toThrow();
    });

    it("accepts a manifest with a user creator", () => {
      const manifest = {
        skillName: "my-own-skill",
        createdAt: "2026-11-15T00:00:00.000Z",
        createdBy: "user",
      };
      expect(() => SkillManifestSchema.parse(manifest)).not.toThrow();
    });

    it("rejects an empty skill name", () => {
      const manifest = {
        skillName: "",
        createdAt: "2026-11-15T00:00:00.000Z",
        createdBy: "paseo-curator",
      };
      expect(() => SkillManifestSchema.parse(manifest)).toThrow();
    });
  });

  describe("ReviewResult", () => {
    it("accepts a valid review result with no operations", () => {
      const result = {
        summary: "Nothing reusable was found in this turn.",
        outcome: "nothing_to_save",
        operations: [],
      };
      expect(() => ReviewResultSchema.parse(result)).not.toThrow();
    });

    it("accepts a valid review result with one operation", () => {
      const result = {
        summary: "Added a new skill.",
        outcome: "saved",
        operations: [
          {
            type: "create",
            skillName: "fixing-flaky-tests",
            content: "---\nname: fixing-flaky-tests\ndescription: How to fix flaky tests.\n---\n\n# Body",
          },
        ],
      };
      expect(() => ReviewResultSchema.parse(result)).not.toThrow();
    });

    it("accepts a valid review result with 20 operations", () => {
      const ops = Array.from({ length: 20 }, (_, i) => ({
        type: "remove_file",
        skillName: `skill-${i}`,
        path: `references/file-${i}.md`,
      }));
      const result = {
        summary: "Cleanup batch.",
        outcome: "saved",
        operations: ops,
      };
      expect(() => ReviewResultSchema.parse(result)).not.toThrow();
    });

    it("rejects a review result with 21 operations", () => {
      const ops = Array.from({ length: 21 }, (_, i) => ({
        type: "remove_file",
        skillName: `skill-${i}`,
        path: `references/file-${i}.md`,
      }));
      const result = {
        summary: "Too many operations.",
        outcome: "saved",
        operations: ops,
      };
      expect(() => ReviewResultSchema.parse(result)).toThrow();
    });

    it("accepts a nothing_to_save outcome with an empty operations array", () => {
      const result = {
        summary: "Nothing reusable.",
        outcome: "nothing_to_save",
        operations: [],
      };
      expect(() => ReviewResultSchema.parse(result)).not.toThrow();
    });

    it("requires summary to be a non-empty string", () => {
      const result = {
        summary: "",
        outcome: "nothing_to_save",
        operations: [],
      };
      expect(() => ReviewResultSchema.parse(result)).toThrow();
    });

    it("rejects an unknown outcome", () => {
      const result = {
        summary: "summary",
        outcome: "mystery",
        operations: [],
      };
      expect(() => ReviewResultSchema.parse(result)).toThrow();
    });

    it("rejects an unknown key", () => {
      const result = {
        summary: "summary",
        outcome: "nothing_to_save",
        operations: [],
        surprise: "nope",
      };
      expect(() => ReviewResultSchema.parse(result)).toThrow();
    });

    it("rejects a malformed operation in the array", () => {
      const result = {
        summary: "summary",
        outcome: "saved",
        operations: [
          {
            type: "create",
            skillName: "bad/name",
            content: "content",
          },
        ],
      };
      expect(() => ReviewResultSchema.parse(result)).toThrow();
    });

    it("rejects a non-array operations field", () => {
      const result = {
        summary: "summary",
        outcome: "saved",
        operations: "not-an-array",
      };
      expect(() => ReviewResultSchema.parse(result)).toThrow();
    });
  });

  describe("AuditRecord", () => {
    it("accepts a valid applied audit record", () => {
      const record = {
        id: "audit-001",
        queueId: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        outcome: "applied",
        timestamp: "2026-11-15T00:02:00.000Z",
        summary: "Applied 1 operation.",
        operationCount: 1,
        operationsHash: "a".repeat(64),
        skillNames: ["learned-skill"],
      };
      expect(() => AuditRecordSchema.parse(record)).not.toThrow();
    });

    it("accepts a valid rejected audit record", () => {
      const record = {
        id: "audit-002",
        queueId: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        outcome: "rejected",
        timestamp: "2026-11-15T00:02:00.000Z",
        summary: "Rejected: path traversal detected.",
        operationCount: 0,
        operationsHash: "b".repeat(64),
        skillNames: [],
        rejectionReason: "path traversal",
      };
      expect(() => AuditRecordSchema.parse(record)).not.toThrow();
    });

    it("rejects an unknown outcome", () => {
      const record = {
        id: "audit-001",
        queueId: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        outcome: "weird",
        timestamp: "2026-11-15T00:02:00.000Z",
        summary: "summary",
        operationCount: 0,
      };
      expect(() => AuditRecordSchema.parse(record)).toThrow();
    });

    it("rejects an unknown key", () => {
      const record = {
        id: "audit-001",
        queueId: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        outcome: "applied",
        timestamp: "2026-11-15T00:02:00.000Z",
        summary: "summary",
        operationCount: 0,
        surprise: "nope",
      };
      expect(() => AuditRecordSchema.parse(record)).toThrow();
    });

    it("requires a non-negative integer operationCount", () => {
      const record = {
        id: "audit-001",
        queueId: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        outcome: "applied",
        timestamp: "2026-11-15T00:02:00.000Z",
        summary: "summary",
        operationCount: -1,
      };
      expect(() => AuditRecordSchema.parse(record)).toThrow();
    });

    it("requires summary to be a non-empty string", () => {
      const record = {
        id: "audit-001",
        queueId: "queue-001",
        sourceAgentId: "agent-001",
        turnId: "turn-001",
        outcome: "applied",
        timestamp: "2026-11-15T00:02:00.000Z",
        summary: "",
        operationCount: 0,
      };
      expect(() => AuditRecordSchema.parse(record)).toThrow();
    });
  });

  describe("PluginConfig", () => {
    it("accepts a minimal valid config", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 20,
      };
      expect(() => PluginConfigSchema.parse(config)).not.toThrow();
    });

    it("accepts a fully specified config", () => {
      const config = {
        skillRoot: "/custom/path",
        reviewThreshold: 5,
        curatorConcurrency: 2,
        maxOperations: 10,
        maintenanceEnabled: true,
        consolidationEnabled: false,
        staleDays: 14,
        archiveDays: 30,
        maxRetries: 3,
      };
      expect(() => PluginConfigSchema.parse(config)).not.toThrow();
    });

    it("rejects a negative reviewThreshold", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: -1,
        curatorConcurrency: 1,
        maxOperations: 20,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects a zero reviewThreshold", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 0,
        curatorConcurrency: 1,
        maxOperations: 20,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects a zero curatorConcurrency", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 0,
        maxOperations: 20,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects a zero maxOperations", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 0,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects a maxOperations exceeding 20", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 21,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects a negative staleDays", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 20,
        staleDays: -1,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects archiveDays less than staleDays", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 20,
        staleDays: 30,
        archiveDays: 14,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects a negative maxRetries", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 20,
        maxRetries: -1,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects an unknown key", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 20,
        surprise: "nope",
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects an empty skillRoot", () => {
      const config = {
        skillRoot: "",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 20,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("rejects a consolidationEnabled value of true when maintenanceEnabled is false", () => {
      // consolidation requires maintenance to be enabled
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 20,
        maintenanceEnabled: false,
        consolidationEnabled: true,
      };
      expect(() => PluginConfigSchema.parse(config)).toThrow();
    });

    it("accepts consolidationEnabled true when maintenanceEnabled is true", () => {
      const config = {
        skillRoot: "~/.agents/skills",
        reviewThreshold: 10,
        curatorConcurrency: 1,
        maxOperations: 20,
        maintenanceEnabled: true,
        consolidationEnabled: true,
      };
      expect(() => PluginConfigSchema.parse(config)).not.toThrow();
    });
  });

  describe("exported schemas", () => {
    it("exports QueueRecordSchema as a Zod object", () => {
      expect(QueueRecordSchema).toBeDefined();
      expect(typeof QueueRecordSchema.parse).toBe("function");
    });

    it("exports ReviewResultSchema as a Zod object", () => {
      expect(ReviewResultSchema).toBeDefined();
      expect(typeof ReviewResultSchema.parse).toBe("function");
    });

    it("exports SkillOperationSchema as a Zod object", () => {
      expect(SkillOperationSchema).toBeDefined();
      expect(typeof SkillOperationSchema.parse).toBe("function");
    });

    it("exports SkillManifestSchema as a Zod object", () => {
      expect(SkillManifestSchema).toBeDefined();
      expect(typeof SkillManifestSchema.parse).toBe("function");
    });

    it("exports AuditRecordSchema as a Zod object", () => {
      expect(AuditRecordSchema).toBeDefined();
      expect(typeof AuditRecordSchema.parse).toBe("function");
    });

    it("exports PluginConfigSchema as a Zod object", () => {
      expect(PluginConfigSchema).toBeDefined();
      expect(typeof PluginConfigSchema.parse).toBe("function");
    });
  });
});
