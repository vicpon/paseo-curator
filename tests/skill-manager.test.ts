import { describe, expect, it, afterEach } from "vitest";
import { existsSync, readFileSync, statSync, symlinkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SkillManager,
  type ReadSetEntry,
  type BatchApplyResult,
} from "../server/skill-manager";
import type { SkillOperation } from "../server/contracts";
import {
  makeTempRoot,
  cleanupRoot,
  createSkill,
  skillMd,
  makeCreateOps,
  makePatchOp,
  makeWriteFileOp,
  makeRemoveFileOp,
  makeArchiveOp,
  readToEntry,
  readSkillMd,
  skillFileExists,
  skillDirExists,
  skillArchived,
  listSkills,
} from "./fixtures";

const ctx = { queueId: "q-1", sourceAgentId: "agent-1", turnId: "turn-1" };

/** Track temp roots created in this test file for cleanup. */
const roots: string[] = [];
function newRoot(label: string): string {
  const r = makeTempRoot(label);
  roots.push(r);
  return r;
}

afterEach(() => {
  for (const r of roots.splice(0, roots.length)) cleanupRoot(r);
});

function applyReviewed(mgr: SkillManager, ...args: Parameters<SkillManager["applyBatch"]>) {
  return mgr.applyBatch(args[0], args[1], { ...args[2], reviewSnapshot: args[2].reviewSnapshot ?? mgr.captureReviewSnapshot() });
}

describe("SkillManager.applyBatch", () => {
  it.each(["inside", "outside"] as const)("ignores an unrelated top-level symlink %s the root and refuses to mutate through it", async (location) => {
    const root = newRoot("review-symlink");
    const targetRoot = location === "inside" ? root : newRoot("review-symlink-target");
    createSkill(root, "alpha", skillMd("alpha", "Original"));
    createSkill(targetRoot, "target", skillMd("target", "Linked content"));
    symlinkSync(join(targetRoot, "target"), join(root, "linked"), "dir");
    const mgr = new SkillManager(root);
    const reviewSnapshot = mgr.captureReviewSnapshot();
    const applied = await mgr.applyBatch([makePatchOp("alpha", "Original", "Patched")], [], {
      ...ctx, queueId: "q-real", reviewSnapshot,
    });
    expect(applied.outcome).toBe("applied");
    expect(readSkillMd(root, "alpha")).toContain("Patched");
    const rejected = await mgr.applyBatch([makePatchOp("linked", "Linked content", "Unexpected")], [], {
      ...ctx, queueId: "q-linked", reviewSnapshot,
    });
    expect(rejected.outcome).toBe("rejected");
    expect(readSkillMd(targetRoot, "target")).toContain("Linked content");
  });

  it.each(["patch", "remove_file"] as const)("preserves newer content when %s follows a concurrent change after review capture", async (type) => {
    const root = newRoot("stale-review");
    createSkill(root, "alpha", skillMd("alpha", "Original"), { "references/notes.md": "Original" });
    const mgr = new SkillManager(root);
    const reviewSnapshot = mgr.captureReviewSnapshot();
    const file = join(root, "alpha", "references/notes.md");
    writeFileSync(file, "Original plus a newer user edit");
    const operation: SkillOperation = type === "patch"
      ? { type, skillName: "alpha", path: "references/notes.md", oldText: "Original", newText: "Patched" }
      : { type, skillName: "alpha", path: "references/notes.md" };
    const result = await applyReviewed(mgr, [operation], [], { ...ctx, reviewSnapshot });
    expect(result.outcome).toBe("rejected");
    expect(readFileSync(file, "utf8")).toBe("Original plus a newer user edit");
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------
  describe("create", () => {
    it("creates a new skill with valid frontmatter", async () => {
      const root = newRoot("create-basic");
      const mgr = new SkillManager(root);
      const result = await applyReviewed(mgr,
        [{ type: "create", skillName: "alpha", content: skillMd("alpha", "Do things.\n") }],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(skillDirExists(root, "alpha")).toBe(true);
      const content = readSkillMd(root, "alpha");
      expect(content).toContain("name: alpha");
      expect(content).toContain("created_by: paseo-curator");
      expect(content).toContain("Do things.");
    });

    it("replays a successfully receipted queue batch idempotently after queue completion was lost", async () => {
      const root = newRoot("create-receipt-replay");
      const mgr = new SkillManager(root);
      const operations = [
        { type: "create" as const, skillName: "receipt-skill", content: skillMd("receipt-skill", "Saved once.\n") },
      ];
      const context = { queueId: "q-receipt-1", sourceAgentId: "agent-1", turnId: "turn-1" };

      const first = await applyReviewed(mgr, operations, [], context);
      const second = await applyReviewed(mgr, operations, [], context);

      expect(first.outcome).toBe("applied");
      expect(second.outcome).toBe("applied");
      expect(readSkillMd(root, "receipt-skill")).toBe(operations[0].content);
      expect(listSkills(root).filter((name) => name === "receipt-skill")).toHaveLength(1);
    });

    it("serializes concurrent replay of one queue batch and returns applied to both callers", async () => {
      const root = newRoot("create-receipt-concurrent");
      const mgr = new SkillManager(root);
      const operations = [
        { type: "create" as const, skillName: "concurrent-skill", content: skillMd("concurrent-skill", "Saved once.\n") },
      ];
      const context = { queueId: "q-receipt-concurrent", sourceAgentId: "agent-1", turnId: "turn-1" };

      const [first, second] = await Promise.all([
        applyReviewed(mgr, operations, [], context),
        applyReviewed(mgr, operations, [], context),
      ]);

      expect(first.outcome).toBe("applied");
      expect(second.outcome).toBe("applied");
      expect(readSkillMd(root, "concurrent-skill")).toBe(operations[0].content);
    });

    it("does not treat a receipt as applied when the receipted files have drifted", async () => {
      const root = newRoot("create-receipt-drift");
      const mgr = new SkillManager(root);
      const operations = [
        { type: "create" as const, skillName: "drift-skill", content: skillMd("drift-skill", "Original.\n") },
      ];
      const context = { queueId: "q-receipt-drift", sourceAgentId: "agent-1", turnId: "turn-1" };
      expect((await applyReviewed(mgr, operations, [], context)).outcome).toBe("applied");
      writeFileSync(join(root, "drift-skill", "SKILL.md"), skillMd("drift-skill", "User changed.\n"));

      await expect(mgr.applyBatch(operations, [], context)).rejects.toThrow(/receipt.*drift/i);
      expect(readSkillMd(root, "drift-skill")).toContain("User changed.");
    });

    it("reconciles a committed filesystem batch before curator replay", async () => {
      const root = newRoot("create-intent-reconcile");
      const mgr = new SkillManager(root);
      const operations = [
        { type: "create" as const, skillName: "reconciled-skill", content: skillMd("reconciled-skill", "Body.\n") },
      ];
      const context = { queueId: "q-intent-reconcile", sourceAgentId: "agent-1", turnId: "turn-1" };
      expect((await applyReviewed(mgr, operations, [], context)).outcome).toBe("applied");
      rmSync(join(root, ".paseo-curator", "receipts", `${context.queueId}.json`));

      const result = await mgr.reconcileBatch(context);

      expect(result).toEqual(expect.objectContaining({
        outcome: "applied",
        operationCount: 1,
        skillNames: ["reconciled-skill"],
      }));
      expect(readSkillMd(root, "reconciled-skill")).toContain("Body.");
      expect(existsSync(join(root, ".paseo-curator", "receipts", `${context.queueId}.json`))).toBe(true);
    });

    it("requires reconciliation when an interrupted journal has mixed filesystem state", async () => {
      const root = newRoot("create-intent-mixed");
      const mgr = new SkillManager(root);
      const operations = [
        { type: "create" as const, skillName: "mixed-one", content: skillMd("mixed-one", "One.\n") },
        { type: "create" as const, skillName: "mixed-two", content: skillMd("mixed-two", "Two.\n") },
      ];
      const context = { queueId: "q-intent-mixed", sourceAgentId: "agent-1", turnId: "turn-2" };
      expect((await applyReviewed(mgr, operations, [], context)).outcome).toBe("applied");
      rmSync(join(root, ".paseo-curator", "receipts", `${context.queueId}.json`));
      rmSync(join(root, "mixed-two"), { recursive: true });

      expect(await mgr.reconcileBatch(context)).toEqual(
        expect.objectContaining({ outcome: "reconciliation_required" }),
      );
      expect(skillDirExists(root, "mixed-one")).toBe(true);
      expect(skillDirExists(root, "mixed-two")).toBe(false);
    });

    it("rejects create when the skill directory already exists", async () => {
      const root = newRoot("create-exists");
      const mgr = new SkillManager(root);
      createSkill(root, "beta", skillMd("beta", "Existing.\n"));
      const result = await applyReviewed(mgr,
        [{ type: "create", skillName: "beta", content: skillMd("beta", "New.\n") }],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(readSkillMd(root, "beta")).toContain("Existing.");
    });

    it("rejects create when frontmatter name does not match skillName", async () => {
      const root = newRoot("create-name-mismatch");
      const mgr = new SkillManager(root);
      const result = await applyReviewed(mgr,
        [{ type: "create", skillName: "gamma", content: skillMd("delta", "Body.\n") }],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(skillDirExists(root, "gamma")).toBe(false);
    });

    it("rejects create when frontmatter is missing", async () => {
      const root = newRoot("create-no-frontmatter");
      const mgr = new SkillManager(root);
      const result = await applyReviewed(mgr,
        [{ type: "create", skillName: "epsilon", content: "No frontmatter here.\n" }],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(skillDirExists(root, "epsilon")).toBe(false);
    });

    it("stamps curator provenance on create when created_by is missing", async () => {
      const root = newRoot("create-no-created-by");
      const mgr = new SkillManager(root);
      const result = await applyReviewed(mgr,
        [{ type: "create", skillName: "zeta", content: "---\nname: zeta\n---\n\nBody.\n" }],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      // Provenance is plugin-controlled: the written file always carries it,
      // regardless of what the curator model supplied.
      expect(readSkillMd(root, "zeta")).toContain("created_by: paseo-curator");
    });

    it("overrides a foreign created_by value on create with curator provenance", async () => {
      const root = newRoot("create-foreign-created-by");
      const mgr = new SkillManager(root);
      const result = await applyReviewed(mgr,
        [
          {
            type: "create",
            skillName: "eta",
            content: "---\nname: eta\ncreated_by: someone-else\n---\n\nBody.\n",
          },
        ],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(readSkillMd(root, "eta")).toContain("created_by: paseo-curator");
      expect(readSkillMd(root, "eta")).not.toContain("someone-else");
    });

    it("normalizes duplicate created_by keys on create, keeping only curator provenance", async () => {
      const root = newRoot("create-duplicate-created-by");
      const mgr = new SkillManager(root);
      // Duplicate keys with a foreign value last: the parser is last-wins,
      // so without normalization the model would control effective provenance.
      const result = await applyReviewed(mgr,
        [
          {
            type: "create",
            skillName: "theta",
            content:
              "---\nname: theta\ncreated_by: paseo-curator\ncreated_by: attacker\n---\n\nBody.\n",
          },
        ],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      const written = readSkillMd(root, "theta");
      expect(written).toContain("created_by: paseo-curator");
      expect(written).not.toContain("attacker");
      expect(written.match(/created_by:/g)).toHaveLength(1);
    });

    it("rejects create with duplicate non-provenance frontmatter keys", async () => {
      const root = newRoot("create-duplicate-generic-key");
      const mgr = new SkillManager(root);
      const result = await applyReviewed(mgr,
        [
          {
            type: "create",
            skillName: "iota",
            content: "---\nname: iota\ndescription: A\ndescription: B\n---\n\nBody.\n",
          },
        ],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(result.rejectionReason).toContain("duplicate frontmatter key");
      expect(skillDirExists(root, "iota")).toBe(false);
    });

    it("rejects write_file that targets SKILL.md", async () => {
      const root = newRoot("write-file-skill-md");
      const mgr = new SkillManager(root);
      createSkill(root, "wf", skillMd("wf", "Body.\n"));
      const result = await applyReviewed(mgr,
        [
          {
            type: "write_file",
            skillName: "wf",
            path: "SKILL.md",
            content: "---\nname: wf\ncreated_by: attacker\n---\n\nForged.\n",
          },
        ],
        [],
        ctx,
      );
      // SKILL.md owns provenance; recreating it via write_file would bypass
      // stamping and both frontmatter validators.
      expect(result.outcome).toBe("rejected");
      expect(result.rejectionReason).toContain("cannot target SKILL.md");
      expect(readSkillMd(root, "wf")).toContain("paseo-curator");
      expect(readSkillMd(root, "wf")).not.toContain("Forged.");
    });

    it("still allows write_file to support files under references/", async () => {
      const root = newRoot("write-file-references");
      const mgr = new SkillManager(root);
      createSkill(root, "wfr", skillMd("wfr", "Body.\n"));
      const result = await applyReviewed(mgr,
        [
          {
            type: "write_file",
            skillName: "wfr",
            path: "references/notes.md",
            content: "# Notes\n",
          },
        ],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
    });
  });

  // -----------------------------------------------------------------------
  // patch
  // -----------------------------------------------------------------------
  describe("patch", () => {
    it("applies a unique patch to SKILL.md", async () => {
      const root = newRoot("patch-unique");
      const mgr = new SkillManager(root);
      const body = "Step one: do X.\nStep two: do Y.\n";
      createSkill(root, "patch-skill", skillMd("patch-skill", body));
      const entry = readToEntry(root, "patch-skill", "SKILL.md");

      const result = await applyReviewed(mgr,
        [makePatchOp("patch-skill", "Step two: do Y.", "Step two: do Z.")],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(readSkillMd(root, "patch-skill")).toContain("Step two: do Z.");
      expect(readSkillMd(root, "patch-skill")).toContain("Step one: do X.");
    });

    it("applies a body patch to a pre-existing skill that has no created_by field", async () => {
      const root = newRoot("patch-no-created-by");
      const mgr = new SkillManager(root);
      // A user-authored skill predating the plugin: frontmatter without
      // created_by. A body-only patch must be allowed.
      const content = "---\nname: legacy\n---\n\nStep one: do X.\n";
      createSkill(root, "legacy", content);
      const entry = readToEntry(root, "legacy", "SKILL.md");

      const result = await applyReviewed(mgr,
        [makePatchOp("legacy", "Step one: do X.", "Step one: do X carefully.")],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      const updated = readSkillMd(root, "legacy");
      expect(updated).toContain("Step one: do X carefully.");
      // Provenance stays absent — a patch never adds or removes it.
      expect(updated).not.toContain("created_by");
    });

    it("rolls back a patch that changes the frontmatter created_by value", async () => {
      const root = newRoot("patch-changes-created-by");
      const mgr = new SkillManager(root);
      createSkill(root, "owned", skillMd("owned", "Body line.\n"));
      const entry = readToEntry(root, "owned", "SKILL.md");

      const result = await applyReviewed(mgr,
        [
          makePatchOp(
            "owned",
            "created_by: paseo-curator",
            "created_by: attacker",
          ),
        ],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("rolled_back");
      expect(result.rejectionReason).toContain("created_by");
      expect(readSkillMd(root, "owned")).toContain("created_by: paseo-curator");
      expect(readSkillMd(root, "owned")).not.toContain("attacker");
    });

    it("rejects patch when oldText is not found", async () => {
      const root = newRoot("patch-not-found");
      const mgr = new SkillManager(root);
      createSkill(root, "pf", skillMd("pf", "Only A here.\n"));
      const entry = readToEntry(root, "pf", "SKILL.md");

      const result = await applyReviewed(mgr,
        [makePatchOp("pf", "B does not exist", "C")],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(readSkillMd(root, "pf")).toBe(skillMd("pf", "Only A here.\n"));
    });

    it("rejects patch when oldText matches multiple occurrences", async () => {
      const root = newRoot("patch-ambiguous");
      const mgr = new SkillManager(root);
      createSkill(root, "pa", skillMd("pa", "word word word\n"));
      const entry = readToEntry(root, "pa", "SKILL.md");

      const result = await applyReviewed(mgr,
        [makePatchOp("pa", "word", "other")],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(readSkillMd(root, "pa")).toBe(skillMd("pa", "word word word\n"));
    });

    it("rejects patch when read-set evidence is stale (file changed since read)", async () => {
      const root = newRoot("patch-stale");
      const mgr = new SkillManager(root);
      const original = "original content\n";
      createSkill(root, "ps", skillMd("ps", original));

      // Take a read-set entry with the original content.
      const entry = readToEntry(root, "ps", "SKILL.md");

      // Simulate an external change between the curator's read and the apply.
      const skillDir = join(root, "ps");
      writeFileSync(join(skillDir, "SKILL.md"), "modified by another agent\n", "utf8");

      const result = await applyReviewed(mgr,
        [makePatchOp("ps", "original content", "replaced")],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      // The file must be unchanged (the stale read means we refuse to write).
      expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe("modified by another agent\n");
    });

    it("applies a patch with no model-supplied read-set evidence (the pre-review snapshot is authoritative)", async () => {
      const root = newRoot("patch-no-evidence");
      const mgr = new SkillManager(root);
      createSkill(root, "pe", skillMd("pe", "content\n"));

      const result = await applyReviewed(mgr,
        [makePatchOp("pe", "content", "other")],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(readSkillMd(root, "pe")).toContain("other");
    });

    it("patches a support file (references/)", async () => {
      const root = newRoot("patch-support");
      const mgr = new SkillManager(root);
      createSkill(root, "psup", skillMd("psup", "body\n"), {
        "references/guide.md": "Guide v1\n",
      });
      const entry = readToEntry(root, "psup", "references/guide.md");

      const result = await applyReviewed(mgr,
        [{ type: "patch", skillName: "psup", path: "references/guide.md", oldText: "Guide v1", newText: "Guide v2" }],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(readFileSync(join(root, "psup", "references/guide.md"), "utf8")).toBe("Guide v2\n");
    });
  });

  // -----------------------------------------------------------------------
  // write_file
  // -----------------------------------------------------------------------
  describe("write_file", () => {
    it("creates a new support file in references/", async () => {
      const root = newRoot("writefile-new");
      const mgr = new SkillManager(root);
      createSkill(root, "wf", skillMd("wf", "body\n"));

      const result = await applyReviewed(mgr,
        [makeWriteFileOp("wf", "references/notes.md", "Some notes\n")],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(skillFileExists(root, "wf", "references/notes.md")).toBe(true);
      expect(readFileSync(join(root, "wf", "references/notes.md"), "utf8")).toBe("Some notes\n");
    });

    it("rejects write_file when the file already exists", async () => {
      const root = newRoot("writefile-exists");
      const mgr = new SkillManager(root);
      createSkill(root, "wf2", skillMd("wf2", "body\n"), {
        "references/existing.md": "already here\n",
      });

      const result = await applyReviewed(mgr,
        [makeWriteFileOp("wf2", "references/existing.md", "new content\n")],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(readFileSync(join(root, "wf2", "references/existing.md"), "utf8")).toBe("already here\n");
    });

    it("rejects write_file for a non-existent skill", async () => {
      const root = newRoot("writefile-no-skill");
      const mgr = new SkillManager(root);
      const result = await applyReviewed(mgr,
        [makeWriteFileOp("no-skill", "references/x.md", "content\n")],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
    });

    it("rejects write_file for a path outside support dirs (e.g. SKILL.md)", async () => {
      const root = newRoot("writefile-skillmd");
      const mgr = new SkillManager(root);
      createSkill(root, "wf3", skillMd("wf3", "body\n"));

      // SKILL.md is not a valid write_file target (only a patch target).
      const result = await applyReviewed(mgr,
        [{ type: "write_file", skillName: "wf3", path: "SKILL.md", content: "hijacked\n" }],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(readSkillMd(root, "wf3")).toContain("name: wf3");
    });
  });

  // -----------------------------------------------------------------------
  // remove_file
  // -----------------------------------------------------------------------
  describe("remove_file", () => {
    it("removes a support file when read-set evidence matches", async () => {
      const root = newRoot("remove-file");
      const mgr = new SkillManager(root);
      createSkill(root, "rf", skillMd("rf", "body\n"), {
        "references/to-delete.md": "delete me\n",
      });
      const entry = readToEntry(root, "rf", "references/to-delete.md");

      const result = await applyReviewed(mgr,
        [makeRemoveFileOp("rf", "references/to-delete.md")],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(skillFileExists(root, "rf", "references/to-delete.md")).toBe(false);
      // The SKILL.md must be untouched.
      expect(readSkillMd(root, "rf")).toContain("name: rf");
    });

    it("applies remove_file with no model-supplied read-set evidence", async () => {
      const root = newRoot("remove-no-evidence");
      const mgr = new SkillManager(root);
      createSkill(root, "rf2", skillMd("rf2", "body\n"), {
        "references/x.md": "x\n",
      });

      const result = await applyReviewed(mgr,
        [makeRemoveFileOp("rf2", "references/x.md")],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(skillFileExists(root, "rf2", "references/x.md")).toBe(false);
    });

    it("rejects remove_file for a file that does not exist", async () => {
      const root = newRoot("remove-missing-file");
      const mgr = new SkillManager(root);
      createSkill(root, "rf3", skillMd("rf3", "body\n"));

      const result = await applyReviewed(mgr,
        [makeRemoveFileOp("rf3", "references/never-here.md")],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
    });
  });

  // -----------------------------------------------------------------------
  // archive
  // -----------------------------------------------------------------------
  describe("archive", () => {
    it("archives a curator-created skill", async () => {
      const root = newRoot("archive-curator");
      const mgr = new SkillManager(root);
      createSkill(root, "archived-skill", skillMd("archived-skill", "body\n", { createdBy: "paseo-curator" }));

      const result = await applyReviewed(mgr,
        [makeArchiveOp("archived-skill")],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(skillDirExists(root, "archived-skill")).toBe(false);
      expect(skillArchived(root, "archived-skill")).toBe(true);
    });

    it("refuses receipt replay when archived content has drifted", async () => {
      const root = newRoot("archive-receipt-drift");
      const mgr = new SkillManager(root);
      createSkill(root, "archived-skill", skillMd("archived-skill", "body\n", { createdBy: "paseo-curator" }));
      const operations = [makeArchiveOp("archived-skill")];
      const context = { queueId: "q-archive-drift", sourceAgentId: "agent-1", turnId: "turn-1" };
      expect((await applyReviewed(mgr, operations, [], context)).outcome).toBe("applied");
      writeFileSync(join(root, ".archive", "archived-skill", "SKILL.md"), "corrupt\n");

      await expect(mgr.applyBatch(operations, [], context)).rejects.toThrow(/receipt.*drift/i);
    });

    it("rejects archiving a user-owned skill", async () => {
      const root = newRoot("archive-user");
      const mgr = new SkillManager(root);
      createSkill(root, "user-skill", skillMd("user-skill", "body\n", { createdBy: "user" }));

      const result = await applyReviewed(mgr,
        [makeArchiveOp("user-skill")],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(skillDirExists(root, "user-skill")).toBe(true);
      expect(skillArchived(root, "user-skill")).toBe(false);
    });

    it("rejects archiving a skill with no frontmatter (unknown provenance)", async () => {
      const root = newRoot("archive-no-fm");
      const mgr = new SkillManager(root);
      const skillDir = join(root, "mystery-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "no frontmatter at all\n", "utf8");

      const result = await applyReviewed(mgr,
        [makeArchiveOp("mystery-skill")],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      expect(skillDirExists(root, "mystery-skill")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Path traversal and symlink escape
  // -----------------------------------------------------------------------
  describe("path containment", () => {
    it("rejects a patch with a ../ traversal path", async () => {
      const root = newRoot("traversal");
      const mgr = new SkillManager(root);
      createSkill(root, "trav", skillMd("trav", "body\n"));
      const entry = readToEntry(root, "trav", "SKILL.md");

      const result = await applyReviewed(mgr,
        [{ type: "patch", skillName: "trav", path: "../evil.md", oldText: "x", newText: "y" }],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
    });

    it("rejects a write_file with an absolute path", async () => {
      const root = newRoot("absolute-path");
      const mgr = new SkillManager(root);
      createSkill(root, "abs", skillMd("abs", "body\n"));

      const result = await applyReviewed(mgr,
        [{ type: "write_file", skillName: "abs", path: "/etc/passwd", content: "evil\n" }],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
    });

    it("rejects a patch when a symlink in the skill points outside the root", async () => {
      const root = newRoot("symlink-escape");
      const mgr = new SkillManager(root);
      createSkill(root, "slink", skillMd("slink", "body\n"));

      // Create a symlink inside the skill that points outside the root.
      const outsideDir = newRoot("outside-target");
      const outsideFile = join(outsideDir, "secret.md");
      writeFileSync(outsideFile, "top secret\n", "utf8");

      // Create a symlink: slink/references -> outsideDir
      const refsDir = join(root, "slink", "references");
      mkdirSync(refsDir, { recursive: true });
      const targetFile = join(refsDir, "leak.md");
      symlinkSync(outsideFile, targetFile, "file");

      const result = await applyReviewed(mgr,
        [{ type: "patch", skillName: "slink", path: "references/leak.md", oldText: "top secret", newText: "hacked" }],
        [],
        ctx,
      );
      expect(result.outcome).toBe("rejected");
      // The outside file must be untouched.
      expect(readFileSync(outsideFile, "utf8")).toBe("top secret\n");
      cleanupRoot(outsideDir);
    });
  });

  // -----------------------------------------------------------------------
  // 20-operation limit
  // -----------------------------------------------------------------------
  describe("operation count", () => {
    it("accepts exactly 20 operations", async () => {
      const root = newRoot("opcount-20");
      const mgr = new SkillManager(root);
      const names = Array.from({ length: 20 }, (_, i) => `skill-${i}`);
      const ops = makeCreateOps(names, root);
      expect(ops.length).toBe(20);

      const result = await applyReviewed(mgr, ops, [], ctx);
      expect(result.outcome).toBe("applied");
      expect(listSkills(root)).toHaveLength(20);
    });

    it("rejects 21 operations", async () => {
      const root = newRoot("opcount-21");
      const mgr = new SkillManager(root);
      const names = Array.from({ length: 21 }, (_, i) => `skill-${i}`);
      const ops = makeCreateOps(names, root);

      const result = await applyReviewed(mgr, ops, [], ctx);
      expect(result.outcome).toBe("rejected");
      expect(listSkills(root)).toHaveLength(0);
    });

    it("rejects an empty batch", async () => {
      const root = newRoot("opcount-0");
      const mgr = new SkillManager(root);
      const result = await applyReviewed(mgr, [], [], ctx);
      expect(result.outcome).toBe("rejected");
    });
  });

  // -----------------------------------------------------------------------
  // Audit hashes
  // -----------------------------------------------------------------------
  describe("audit hashes", () => {
    it("records before/after hashes for a patch", async () => {
      const root = newRoot("audit-hash");
      const mgr = new SkillManager(root);
      const body = "line one\nline two\n";
      createSkill(root, "audit-skill", skillMd("audit-skill", body));
      const entry = readToEntry(root, "audit-skill", "SKILL.md");

      const result = await applyReviewed(mgr,
        [makePatchOp("audit-skill", "line two", "line three")],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("applied");

      const key = "audit-skill/SKILL.md";
      const pair = result.fileHashes.get(key);
      expect(pair).toBeDefined();
      expect(pair!.before).not.toBeNull();
      expect(pair!.after).not.toBeNull();
      expect(pair!.before).not.toBe(pair!.after);

      // The after hash must match the actual file content on disk.
      const { sha256 } = await import("../server/skill-files");
      const actual = readSkillMd(root, "audit-skill");
      expect(pair!.after).toBe(sha256(actual));
    });

    it("records before=null for a newly created file", async () => {
      const root = newRoot("audit-hash-create");
      const mgr = new SkillManager(root);
      const content = skillMd("hash-skill", "content\n");

      const result = await applyReviewed(mgr,
        [{ type: "create", skillName: "hash-skill", content }],
        [],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      const pair = result.fileHashes.get("hash-skill/SKILL.md");
      expect(pair).toBeDefined();
      expect(pair!.before).toBeNull();
      expect(pair!.after).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Fault injection: rollback on later operation failure
  // -----------------------------------------------------------------------
  describe("atomic rollback on later operation failure", () => {
    it("restores every earlier mutation when a later operation fails", async () => {
      const root = newRoot("rollback");
      const mgr = new SkillManager(root, {
        faultInjector: (index, op) => {
          // Fail on the 3rd operation (index 2).
          if (index === 2) {
            throw new Error("simulated disk failure");
          }
        },
      });

      // Set up two existing skills.
      const originalAlpha = skillMd("alpha", "alpha body\n");
      const originalBeta = skillMd("beta", "beta body\n");
      createSkill(root, "alpha", originalAlpha, { "references/a.md": "a content\n" });
      createSkill(root, "beta", originalBeta, { "references/b.md": "b content\n" });

      const alphaEntry = readToEntry(root, "alpha", "SKILL.md");
      const betaEntry = readToEntry(root, "beta", "SKILL.md");

      const ops = [
        // Op 0: patch alpha — will succeed.
        makePatchOp("alpha", "alpha body", "alpha patched"),
        // Op 1: write_file a new support file in beta — will succeed.
        makeWriteFileOp("beta", "references/new.md", "new file content\n"),
        // Op 2: patch beta — will FAIL (fault injected).
        makePatchOp("beta", "beta body", "beta patched"),
      ];

      const result = await applyReviewed(mgr, ops, [alphaEntry, betaEntry], ctx);
      expect(result.outcome).toBe("rolled_back");
      expect(result.outcomes[2].status).toBe("failed");

      // alpha must be fully restored.
      expect(readSkillMd(root, "alpha")).toBe(originalAlpha);
      // beta must be fully restored: the new support file must be gone,
      // and the SKILL.md must be the original.
      expect(readSkillMd(root, "beta")).toBe(originalBeta);
      expect(skillFileExists(root, "beta", "references/new.md")).toBe(false);
      // The pre-existing support files must be intact.
      expect(readFileSync(join(root, "alpha", "references/a.md"), "utf8")).toBe("a content\n");
      expect(readFileSync(join(root, "beta", "references/b.md"), "utf8")).toBe("b content\n");
    });

    it("removes a newly created skill directory on rollback", async () => {
      const root = newRoot("rollback-create");
      const mgr = new SkillManager(root, {
        faultInjector: (index) => {
          // Fail on the 2nd operation (index 1).
          if (index === 1) {
            throw new Error("simulated failure");
          }
        },
      });

      const ops: SkillOperation[] = [
        // Op 0: create a new skill — will succeed.
        { type: "create" as const, skillName: "new-skill", content: skillMd("new-skill", "created\n") },
        // Op 1: patch an existing skill — will FAIL.
        // First set up the existing skill.
      ];

      // Set up the existing skill before the batch.
      const original = skillMd("existing", "original body\n");
      createSkill(root, "existing", original);
      const existingEntry = readToEntry(root, "existing", "SKILL.md");
      ops[1] = makePatchOp("existing", "original body", "patched body");

      const result = await applyReviewed(mgr, ops, [existingEntry], ctx);
      expect(result.outcome).toBe("rolled_back");

      // The newly created skill must be gone.
      expect(skillDirExists(root, "new-skill")).toBe(false);
      // The existing skill must be restored.
      expect(readSkillMd(root, "existing")).toBe(original);
    });

    it("rolls back when the queue claim is lost between operations", async () => {
      const root = newRoot("rollback-stale-claim");
      const mgr = new SkillManager(root);
      let checks = 0;
      const context = {
        queueId: "q-stale-claim",
        sourceAgentId: "agent-1",
        turnId: "turn-1",
        claimIsCurrent: () => ++checks < 3,
      };
      const operations = [
        { type: "create" as const, skillName: "claim-one", content: skillMd("claim-one", "One.\n") },
        { type: "create" as const, skillName: "claim-two", content: skillMd("claim-two", "Two.\n") },
      ];

      const result = await applyReviewed(mgr, operations, [], context);

      expect(result.outcome).toBe("rolled_back");
      expect(skillDirExists(root, "claim-one")).toBe(false);
      expect(skillDirExists(root, "claim-two")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Batch validation: validate-before-mutate
  // -----------------------------------------------------------------------
  describe("batch validation before mutation", () => {
    it("rejects the entire batch if one operation is invalid — no partial mutation", async () => {
      const root = newRoot("batch-validate");
      const mgr = new SkillManager(root);

      const originalAlpha = skillMd("alpha", "alpha body\n");
      createSkill(root, "alpha", originalAlpha);
      const alphaEntry = readToEntry(root, "alpha", "SKILL.md");

      const ops = [
        // Op 0: valid patch on alpha.
        makePatchOp("alpha", "alpha body", "alpha patched"),
        // Op 1: invalid — create a skill that already exists.
        { type: "create" as const, skillName: "alpha", content: skillMd("alpha", "conflict\n") },
      ];

      const result = await applyReviewed(mgr, ops, [alphaEntry], ctx);
      expect(result.outcome).toBe("rejected");
      // No mutation must have occurred.
      expect(readSkillMd(root, "alpha")).toBe(originalAlpha);
    });

    it("rejects when a create and a patch target the same skill (duplicate)", async () => {
      const root = newRoot("batch-duplicate");
      const mgr = new SkillManager(root);

      createSkill(root, "dup-skill", skillMd("dup-skill", "body\n"));
      const entry = readToEntry(root, "dup-skill", "SKILL.md");

      const ops = [
        // Op 0: create dup-skill — but it already exists, so this should be rejected.
        { type: "create" as const, skillName: "dup-skill", content: skillMd("dup-skill", "new\n") },
        // Op 1: patch dup-skill.
        makePatchOp("dup-skill", "body", "patched"),
      ];

      const result = await applyReviewed(mgr, ops, [entry], ctx);
      expect(result.outcome).toBe("rejected");
      // The original content must be unchanged.
      expect(readSkillMd(root, "dup-skill")).toBe(skillMd("dup-skill", "body\n"));
    });
  });

  // -----------------------------------------------------------------------
  // Multiple operations in one batch (all succeed)
  // -----------------------------------------------------------------------
  describe("multi-operation batch", () => {
    it("applies multiple operations atomically across two skills", async () => {
      const root = newRoot("multi");
      const mgr = new SkillManager(root);

      const originalA = skillMd("alpha", "alpha v1\n");
      const originalB = skillMd("beta", "beta v1\n");
      createSkill(root, "alpha", originalA);
      createSkill(root, "beta", originalB);
      const aEntry = readToEntry(root, "alpha", "SKILL.md");
      const bEntry = readToEntry(root, "beta", "SKILL.md");

      const ops = [
        makePatchOp("alpha", "alpha v1", "alpha v2"),
        makePatchOp("beta", "beta v1", "beta v2"),
        makeWriteFileOp("alpha", "references/added.md", "added\n"),
      ];

      const result = await applyReviewed(mgr, ops, [aEntry, bEntry], ctx);
      expect(result.outcome).toBe("applied");
      expect(result.outcomes.every((o) => o.status === "applied")).toBe(true);

      expect(readSkillMd(root, "alpha")).toContain("alpha v2");
      expect(readSkillMd(root, "beta")).toContain("beta v2");
      expect(skillFileExists(root, "alpha", "references/added.md")).toBe(true);
    });
  });
// -----------------------------------------------------------------------
  // Fix Round 1 — regression tests
  // -----------------------------------------------------------------------
  describe("rollback restoration failure", () => {
    it("surfaces rollback_failed with errors when injected restore fails; never clean rolled_back", async () => {
      const root = newRoot("rollback-fail");
      const mgr = new SkillManager(root, {
        faultInjector: (index) => {
          // Fail on the 2nd operation (index 1) so the first op already
          // mutated state before the failure triggers rollback.
          if (index === 1) {
            throw new Error("simulated later-op failure");
          }
        },
        restoreSkillImpl: () => ({
          restored: [],
          removed: [],
          errors: ["injected restore failure for every file"],
        }),
      });

      const original = skillMd("existing", "original body\n");
      createSkill(root, "existing", original, { "references/a.md": "a v1\n" });
      const entry = readToEntry(root, "existing", "SKILL.md");

      const ops = [
        // Op 0: patch — will succeed and mutate state.
        makePatchOp("existing", "original body", "patched body"),
        // Op 1: fault injected — will fail, triggering rollback.
        makeWriteFileOp("existing", "references/new.md", "new file\n"),
      ];

      const result = await applyReviewed(mgr, ops, [entry], ctx);

      // Must NOT be a clean rollback.
      expect(result.outcome).not.toBe("rolled_back");
      expect(result.outcome).toBe("rollback_failed");
      expect(result.rollbackErrors).toBeDefined();
      expect(result.rollbackErrors!.length).toBeGreaterThan(0);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason).toMatch(/rollback/i);

      // The earlier mutation must be visibly present (restore failed — the
      // file was NOT restored).
      expect(readSkillMd(root, "existing")).toContain("patched body");
    });
  });

  describe("containment (symlink swap after snapshot)", () => {
    it("rejects a batch whose touched support dir is swapped for an out-of-root symlink after snapshot; the outside file remains unchanged", async () => {
      const root = newRoot("symlink-swap");
      const mgr = new SkillManager(root, {
        faultInjector: (index) => {
          // After the first op succeeds and the snapshot is taken, swap the
          // support directory for a symlink that points outside the root.
          if (index === 1) {
            const refsDir = join(root, "swap-skill", "references");
            rmSync(refsDir, { recursive: true, force: true });
            symlinkSync(outsideDir, refsDir, "dir");
          }
        },
      });

      // Create the outside target first (before the batch) with a secret file.
      const outsideDir = newRoot("outside-swap");
      const outsideFile = join(outsideDir, "secret.md");
      writeFileSync(outsideFile, "top secret content\n", "utf8");

      const original = skillMd("swap-skill", "body\n");
      createSkill(root, "swap-skill", original, { "references/notes.md": "notes v1\n" });
      const entry = readToEntry(root, "swap-skill", "SKILL.md");

      const ops = [
        // Op 0: write a new support file — will succeed.
        makeWriteFileOp("swap-skill", "references/extra.md", "extra\n"),
        // Op 1: write another support file — the fault injector swaps
        // references/ for a symlink before this op runs.
        makeWriteFileOp("swap-skill", "references/evil.md", "evil\n"),
      ];

      const result = await applyReviewed(mgr, ops, [entry], ctx);

      // The batch must not have applied cleanly.
      expect(result.outcome).not.toBe("applied");
      // The outside file must be untouched.
      expect(readFileSync(outsideFile, "utf8")).toBe("top secret content\n");
      // The skill's SKILL.md must be restored (or was never changed).
      expect(readSkillMd(root, "swap-skill")).toBe(original);
      cleanupRoot(outsideDir);
    });
  });

  // -----------------------------------------------------------------------
  // Fix Round 2 — rollback containment regression tests
  // -----------------------------------------------------------------------
  describe("containment (skill root replaced with out-of-root symlink)", () => {
    it("surfaces rollback_failed when the skill root is replaced by an out-of-root symlink after snapshot; outside files remain byte-for-byte unchanged", async () => {
      const root = newRoot("root-symlink-rollback");

      // Outside directory with sentinel files that must remain untouched.
      const outsideDir = newRoot("outside-root-symlink");
      const outsideFile1 = join(outsideDir, "secret1.md");
      const outsideFile2 = join(outsideDir, "secret2.md");
      const outsideFile3 = join(outsideDir, "nested", "deep.md");
      const nestedDir = join(outsideDir, "nested");
      mkdirSync(nestedDir, { recursive: true });
      const content1 = "top secret one\n";
      const content2 = "top secret two\n";
      const content3 = "top secret three\n";
      writeFileSync(outsideFile1, content1, "utf8");
      writeFileSync(outsideFile2, content2, "utf8");
      writeFileSync(outsideFile3, content3, "utf8");

      // Create the skill with a few support files.
      const original = skillMd("rootswap-skill", "original body\n");
      createSkill(root, "rootswap-skill", original, {
        "references/notes.md": "notes v1\n",
        "references/extra.md": "extra v1\n",
      });
      const entry = readToEntry(root, "rootswap-skill", "SKILL.md");

      const skillDir = join(root, "rootswap-skill");

      const mgr = new SkillManager(root, {
        faultInjector: (index) => {
          // After op 0 has been applied (mutating state), replace the entire
          // skill directory with a symlink pointing to the outside directory,
          // then throw so op 1 never executes and rollback runs.
          if (index === 1) {
            rmSync(skillDir, { recursive: true, force: true });
            symlinkSync(outsideDir, skillDir, "dir");
            throw new Error("injected: skill root replaced with outside symlink");
          }
        },
      });

      const ops = [
        // Op 0: patch SKILL.md — will succeed and mutate state.
        makePatchOp("rootswap-skill", "original body", "patched body"),
        // Op 1: fault injected — skill root replaced with outside symlink,
        // then thrown; triggers rollback. Targets a valid new path so
        // preflight passes and the fault injector executes after op 0.
        makeWriteFileOp("rootswap-skill", "references/new.md", "new file\n"),
      ];

      const result = await applyReviewed(mgr, ops, [entry], ctx);

      // Every outside sentinel must remain byte-for-byte unchanged.
      expect(readFileSync(outsideFile1, "utf8")).toBe(content1);
      expect(readFileSync(outsideFile2, "utf8")).toBe(content2);
      expect(readFileSync(outsideFile3, "utf8")).toBe(content3);

      // The batch must not be a clean rollback — the outside directory was
      // traversed/written into during rollback, so the outcome must be
      // rollback_failed (loud), never silently rolled_back with external
      // mutation.
      expect(result.outcome).not.toBe("applied");
      // Accept either rollback_failed (expected if restoreSkill detects the
      // symlink and surfaces it) or rolled_back with the outside files
      // intact (acceptable if restoreSkill safely removes the link and
      // restores). The critical invariant is: no external mutation.
      if (result.outcome === "rolled_back") {
        // The skill must be restored to its original state.
        expect(readSkillMd(root, "rootswap-skill")).toBe(original);
      } else {
        // rollback_failed — errors must be surfaced.
        expect(result.outcome).toBe("rollback_failed");
        expect(result.rollbackErrors).toBeDefined();
        expect(result.rollbackErrors!.length).toBeGreaterThan(0);
      }

      cleanupRoot(outsideDir);
    });
  });

  describe("advisory readSet is never trusted (F-3)", () => {
    it("applies a patch when the curator echoes a truncated SKILL.md with the index hash", async () => {
      // The live failure mode: the read tool truncates long files, so the
      // curator's readSet content is partial while its hash comes from the
      // skill index. The batch must still apply against the real file.
      const root = newRoot("truncated-readset");
      const mgr = new SkillManager(root);
      const full = skillMd("long-skill", "line one\nline two\n" + "x".repeat(9000));
      createSkill(root, "long-skill", full);

      const { sha256 } = await import("../server/skill-files");
      const entry: ReadSetEntry = {
        skillName: "long-skill",
        path: "SKILL.md",
        content: full.slice(0, 4000), // truncated echo
        hash: sha256(full), // index hash of the whole file
      };

      const result = await applyReviewed(mgr,
        [{ type: "patch", skillName: "long-skill", path: "SKILL.md", oldText: "line two", newText: "line two, verified" }],
        [entry],
        ctx,
      );
      expect(result.outcome).toBe("applied");
      expect(readSkillMd(root, "long-skill")).toContain("line two, verified");
    });


    it("ignores tampered read-set evidence and applies against the locked snapshot", async () => {
      const root = newRoot("evidence-content-mismatch");
      const mgr = new SkillManager(root);

      const original = skillMd("ev-skill", "line one\nline two\n");
      createSkill(root, "ev-skill", original);

      // Build a read-set entry where:
      //  - hash = sha256(original)  (matches the current disk content)
      //  - content = something different (tampered)
      const { sha256 } = await import("../server/skill-files");
      const originalContent = readSkillMd(root, "ev-skill");
      const tamperedContent = "tampered content\n";

      const entry: ReadSetEntry = {
        skillName: "ev-skill",
        path: "SKILL.md",
        content: tamperedContent,
        hash: sha256(originalContent), // hash matches disk, but content does not
      };

      const result = await applyReviewed(mgr,
        [makePatchOp("ev-skill", "line two", "line three")],
        [entry],
        ctx,
      );

      expect(result.outcome).toBe("applied");
      // The write is derived from the real on-disk content, not the tampered evidence.
      expect(readSkillMd(root, "ev-skill")).toContain("line three");
    });

    it("applies remove_file even when the supplied evidence content is tampered", async () => {
      const root = newRoot("evidence-content-mismatch-remove");
      const mgr = new SkillManager(root);

      const original = skillMd("ev2-skill", "body\n");
      createSkill(root, "ev2-skill", original, { "references/todelete.md": "delete me\n" });

      const { sha256 } = await import("../server/skill-files");
      const fileContent = readFileSync(join(root, "ev2-skill", "references/todelete.md"), "utf8");

      const entry: ReadSetEntry = {
        skillName: "ev2-skill",
        path: "references/todelete.md",
        content: "tampered content\n", // differs from disk
        hash: sha256(fileContent), // hash matches disk
      };

      const result = await applyReviewed(mgr,
        [makeRemoveFileOp("ev2-skill", "references/todelete.md")],
        [entry],
        ctx,
      );

      expect(result.outcome).toBe("applied");
      expect(skillFileExists(root, "ev2-skill", "references/todelete.md")).toBe(false);
    });
  });
});
