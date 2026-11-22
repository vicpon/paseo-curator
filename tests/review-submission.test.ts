import { describe, expect, it } from "vitest";
import { SubmissionArgumentContract, SubmissionToolInput, validateSubmission } from "../server/review-submission";
const noop = { summary: "No reusable lesson", outcome: "nothing_to_save", operations: [] };
const saved = { summary: "Reusable lesson", outcome: "saved", operations: [{ type: "patch", skillName: "alpha", path: "SKILL.md", oldText: "old", newText: "new" }] };

describe("submission arguments, never prose extraction", () => {
  it.each([JSON.stringify(noop), `\`\`\`json\n${JSON.stringify(saved)}\n\`\`\``, "Nothing to save.", "", null, [], 4])("rejects freeform or non-object input %j", input => {
    expect(validateSubmission(input).ok).toBe(false);
  });
  it.each([noop, saved])("accepts strict structured arguments", input => {
    expect(validateSubmission(input)).toEqual({ ok: true, value: input });
  });
  it.each([
    { ...noop, summary: "" }, { ...noop, summary: "x".repeat(2001) }, { ...noop, outcome: "unknown-secret" },
    { ...saved, operations: [] }, { ...noop, operations: saved.operations },
    { ...noop, readSet: [] }, { ...noop, agentId: "authority-secret" }, { ...noop, sourceTurnId: "authority-secret" },
    { ...noop, claimAttempt: 1 }, { ...saved, operations: [{ type: "archive", skillName: "alpha" }] },
    { ...saved, operations: Array(21).fill(saved.operations[0]) },
    { ...saved, operations: [{ ...saved.operations[0], path: "../escape" }] },
    { ...saved, operations: [{ ...saved.operations[0], skillName: "../escape" }] },
    { ...saved, operations: [{ ...saved.operations[0], oldText: "" }] },
    { ...saved, operations: [{ type: "write_file", skillName: "alpha", path: "SKILL.md", content: "secret" }] },
    { ...saved, operations: [{ type: "remove_file", skillName: "alpha", path: "SKILL.md" }] },
    { ...saved, operations: [{ type: "create", skillName: "alpha", content: "x".repeat(256_000) }] },
  ])("returns bounded schema feedback for invalid structure", async input => {
    const result = validateSubmission(input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/authority-secret|unknown-secret/);
    expect(JSON.stringify(result).length).toBeLessThan(1000);
    // The transport envelope must deliver invalid object arguments unchanged
    // so strict validation and budget accounting happen inside the callback.
    expect(validateSubmission(await SubmissionToolInput.parseAsync(input)).ok).toBe(false);
  });
});

it.each(["[]", "[{\"type\":\"create\"}]", 1, false, null, {}, { type: "create" }])("explains native operations arrays for %j without coercion", operations => {
  const result = validateSubmission({ ...noop, operations });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.feedback).toContain("JSON array");
    expect(result.feedback).toContain('"operations":[]');
    expect(result.feedback).toContain("never a JSON-encoded string");
  }
});

it("advertises only review operations, excluding maintenance-only archive", () => {
  const contract = JSON.parse(SubmissionArgumentContract);
  expect(contract.properties.operations.items.oneOf.map((option: { properties: { type: { const: string } } }) => option.properties.type.const)).toEqual([
    "create", "patch", "write_file", "remove_file",
  ]);
});
