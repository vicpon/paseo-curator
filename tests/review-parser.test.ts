import { describe, expect, it } from "vitest";

import { parseReviewResult, lastParseError } from "../server/review-parser";
import type { ReviewResult } from "../server/review-parser";
import type { SkillOperation } from "../server/contracts";
import { MAX_OPERATIONS, ReviewResultSchema } from "../server/contracts";
import { sha256 } from "../server/skill-files";

// ===========================================================================
// Hand-derived literals — computed independently of any implementation
// ===========================================================================

/** SHA-256 of the empty string (FIPS 180-4 test vector). */
const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// SHA-256 of "hello world" — computed with node:crypto.
const SHA256_HELLO_WORLD =
  "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

// Content of a small SKILL.md fixture whose hash must be verified in tests.
const SKILL_MD_CONTENT =
  "---\nname: git-hygiene\ndescription: Commit and branch conventions.\n---\n\n## Rules\n\n- Conventional commits.\n";

// SHA-256 of SKILL_MD_CONTENT (computed independently via node:crypto).
const SHA256_SKILL_MD = sha256(SKILL_MD_CONTENT);

// A support-file content with a known hash.
const SUPPORT_CONTENT = "line one\nline two\n";
const SHA256_SUPPORT = sha256(SUPPORT_CONTENT);

/** A valid patch operation whose readSet evidence will be checked. */
const validPatchOp: SkillOperation = {
  type: "patch",
  skillName: "git-hygiene",
  path: "SKILL.md",
  oldText: "## Rules",
  newText: "## Rules (v2)",
};

/** A valid write_file operation (no readSet entry needed). */
const validWriteFileOp: SkillOperation = {
  type: "write_file",
  skillName: "git-hygiene",
  path: "references/example.md",
  content: SUPPORT_CONTENT,
};

/** A valid create operation. */
const validCreateOp: SkillOperation = {
  type: "create",
  skillName: "test-repair",
  content: SKILL_MD_CONTENT,
};

/** A valid archive operation. */
const validArchiveOp: SkillOperation = {
  type: "archive",
  skillName: "stale-skill",
};

/** A valid remove_file operation. */
const validRemoveFileOp: SkillOperation = {
  type: "remove_file",
  skillName: "git-hygiene",
  path: "references/example.md",
};

// ===========================================================================
// Document builders
// ===========================================================================

function doc(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    summary: "A verified lesson about deterministic test repair.",
    outcome: "saved",
    operations: [validCreateOp],
    readSet: [],
    ...overrides,
  };
}

/** JSON-stringify a doc object (or pre-built string) into the raw model output string. */
function raw(d: Record<string, unknown> | string): string {
  return typeof d === "string" ? d : JSON.stringify(d);
}

// ===========================================================================
// Plain JSON
// ===========================================================================

describe("plain JSON acceptance", () => {
  it("parses a plain JSON object with a valid review document", () => {
    const r = parseReviewResult(raw(doc({})));
    expect(r).not.toBeNull();
    const result = r! as ReviewResult;
    expect(result.summary).toBe("A verified lesson about deterministic test repair.");
    expect(result.outcome).toBe("saved");
    expect(result.operations).toEqual([validCreateOp]);
    expect(result.readSet).toEqual([]);
  });

  it("parses a plain JSON document with outcome nothing_to_save and no operations", () => {
    const r = parseReviewResult(raw(doc({ outcome: "nothing_to_save", operations: [] })));
    expect(r).not.toBeNull();
    const result = r! as ReviewResult;
    expect(result.outcome).toBe("nothing_to_save");
    expect(result.operations).toEqual([]);
  });

  it("preserves the summary string exactly, including whitespace and unicode", () => {
    const special = "  Leading and trailing spaces  \n\ntab\there\nunicode: \u00e9\u4e2d\u6587";
    const r = parseReviewResult(raw(doc({ summary: special })));
    expect(r).not.toBeNull();
    expect((r! as ReviewResult).summary).toBe(special);
  });
});

// ===========================================================================
// Single fenced JSON
// ===========================================================================

describe("single fenced JSON acceptance", () => {
  it("parses a response with exactly one fenced json block and no other prose", () => {
    const payload = raw(doc({}));
    const r = parseReviewResult(`\`\`\`json\n${payload}\n\`\`\`\n`);
    expect(r).not.toBeNull();
    expect((r! as ReviewResult).summary).toBe("A verified lesson about deterministic test repair.");
  });

  it("parses a fenced JSON block with language tag 'JSON' (case-insensitive)", () => {
    const payload = raw(doc({}));
    const r = parseReviewResult(`\`\`\`JSON\n${payload}\n\`\`\``);
    expect(r).not.toBeNull();
  });

  it("parses a fenced JSON block that fills the entire response", () => {
    const payload = raw(doc({}));
    const r = parseReviewResult(`\`\`\`json\n${payload}\n\`\`\``);
    expect(r).not.toBeNull();
    expect((r! as ReviewResult).outcome).toBe("saved");
  });
});

// ===========================================================================
// Prose ambiguity rejection
// ===========================================================================

describe("prose ambiguity rejection", () => {
  it("rejects prose that wraps JSON without a fence and contains narrative before and after", () => {
    const payload = raw(doc({}));
    const r = parseReviewResult(
      `I reviewed the turn. Here is the result:\n${payload}\nThat covers everything.`,
    );
    expect(r).toBeNull();
  });

  it("rejects a response with JSON embedded in prose with no fence markers", () => {
    const payload = raw(doc({}));
    const r = parseReviewResult(`Consider: ${payload} as the output.`);
    expect(r).toBeNull();
  });

  it("rejects a response whose prose contains the JSON text but also other text after", () => {
    const payload = raw(doc({}));
    const r = parseReviewResult(`${payload}\n\nAdditionally, I note the following caveats...`);
    expect(r).toBeNull();
  });
});

// ===========================================================================
// Multiple candidates / fences
// ===========================================================================

describe("multiple candidates and fences", () => {
  it("rejects a response with two fenced json blocks", () => {
    const a = raw(doc({}));
    const b = raw(doc({ summary: "Second document." }));
    const r = parseReviewResult(`\`\`\`json\n${a}\n\`\`\`\n\n\`\`\`json\n${b}\n\`\`\``);
    expect(r).toBeNull();
  });

  it("rejects a response with one fenced and one plain JSON object", () => {
    const a = raw(doc({}));
    const b = raw(doc({ summary: "Another." }));
    const r = parseReviewResult(`\`\`\`json\n${a}\n\`\`\`\n${b}`);
    expect(r).toBeNull();
  });

  it("rejects a response with two inline JSON objects (no fences)", () => {
    const a = raw(doc({}));
    const b = raw(doc({ summary: "Second." }));
    const r = parseReviewResult(`${a}\n${b}`);
    expect(r).toBeNull();
  });

  it("rejects a fenced block followed by a second fenced block with trailing prose", () => {
    const a = raw(doc({}));
    const b = raw(doc({ summary: "Extra." }));
    const r = parseReviewResult(`\`\`\`json\n${a}\n\`\`\`\nSome more prose.\n\`\`\`json\n${b}\n\`\`\``);
    expect(r).toBeNull();
  });
});

// ===========================================================================
// Trailing payload
// ===========================================================================

describe("trailing payload rejection", () => {
  it("rejects when non-whitespace characters follow a plain JSON object", () => {
    const r = parseReviewResult(`${raw(doc({}))} extra trailing text`);
    expect(r).toBeNull();
  });

  it("tolerates prose chatter after a fenced JSON block", () => {
    const r = parseReviewResult(`\`\`\`json\n${raw(doc({}))}\n\`\`\`\ntrailing garbage`);
    expect(r).not.toBeNull();
  });

  it("tolerates prose chatter before a fenced JSON block", () => {
    const r = parseReviewResult(`intro text\n\`\`\`json\n${raw(doc({}))}\n\`\`\``);
    expect(r).not.toBeNull();
  });

  it("rejects prose that contains a complete second JSON object before the fence", () => {
    const r = parseReviewResult(`${raw(doc({ summary: "Rival." }))}\n\`\`\`json\n${raw(doc({}))}\n\`\`\``);
    expect(r).toBeNull();
  });

  it("accepts trailing whitespace after a fenced JSON block", () => {
    const r = parseReviewResult(`\`\`\`json\n${raw(doc({}))}\n\`\`\`\n\n\n`);
    expect(r).not.toBeNull();
  });
});

// ===========================================================================
// Non-object / invalid JSON
// ===========================================================================

describe("non-object and invalid JSON", () => {
  it("rejects a JSON array", () => {
    const r = parseReviewResult(`["a", "b", "c"]`);
    expect(r).toBeNull();
  });

  it("rejects a JSON string scalar", () => {
    const r = parseReviewResult(`"just a string"`);
    expect(r).toBeNull();
  });

  it("rejects a JSON number", () => {
    const r = parseReviewResult(`42`);
    expect(r).toBeNull();
  });

  it("rejects a JSON null", () => {
    const r = parseReviewResult(`null`);
    expect(r).toBeNull();
  });

  it("rejects a JSON boolean", () => {
    const r = parseReviewResult(`true`);
    expect(r).toBeNull();
  });

  it("rejects syntactically invalid JSON", () => {
    const r = parseReviewResult(`{"summary": "unterminated`);
    expect(r).toBeNull();
  });

  it("rejects an empty string", () => {
    const r = parseReviewResult(``);
    expect(r).toBeNull();
  });

  it("rejects whitespace-only input", () => {
    const r = parseReviewResult(`   \n\t  `);
    expect(r).toBeNull();
  });
});

// ===========================================================================
// Task 1 schema validation
// ===========================================================================

describe("Task 1 schema validation (ReviewResultSchema)", () => {
  it("rejects an unknown top-level key", () => {
    const r = parseReviewResult(raw(doc({}) + "").replace("}", '", "unexpected": 1}'));
    // The above produces {summary, outcome, operations, readSet, unexpected}
    expect(r).toBeNull();
  });

  it("rejects a missing summary key", () => {
    const d = doc({});
    delete d.summary;
    const r = parseReviewResult(raw(d));
    expect(r).toBeNull();
  });

  it("rejects a missing outcome key", () => {
    const d = doc({});
    delete d.outcome;
    const r = parseReviewResult(raw(d));
    expect(r).toBeNull();
  });

  it("rejects an invalid outcome value", () => {
    const r = parseReviewResult(raw(doc({ outcome: "maybe" })));
    expect(r).toBeNull();
  });

  it("rejects an empty summary", () => {
    const r = parseReviewResult(raw(doc({ summary: "" })));
    expect(r).toBeNull();
  });

  it("rejects a non-string summary", () => {
    const d = doc({});
    d.summary = 123;
    const r = parseReviewResult(raw(d));
    expect(r).toBeNull();
  });

  it("rejects a null operations field", () => {
    const d = doc({});
    d.operations = null;
    const r = parseReviewResult(raw(d));
    expect(r).toBeNull();
  });

  it("rejects an operations field that is not an array", () => {
    const d = doc({});
    d.operations = "not-an-array";
    const r = parseReviewResult(raw(d));
    expect(r).toBeNull();
  });
});

// ===========================================================================
// Operation count: 20 accepted, 21 rejected
// ===========================================================================

describe("operation count limits", () => {
  function makeOps(n: number): SkillOperation[] {
    const ops: SkillOperation[] = [];
    for (let i = 0; i < n; i++) {
      ops.push({
        type: "create",
        skillName: `skill-${String(i).padStart(3, "0")}`,
        content: SKILL_MD_CONTENT,
      });
    }
    return ops;
  }

  it("accepts exactly 20 operations", () => {
    expect(MAX_OPERATIONS).toBe(20);
    const r = parseReviewResult(raw(doc({ operations: makeOps(20) })));
    expect(r).not.toBeNull();
    expect((r! as ReviewResult).operations).toHaveLength(20);
  });

  it("rejects 21 operations", () => {
    const r = parseReviewResult(raw(doc({ operations: makeOps(21) })));
    expect(r).toBeNull();
  });

  it("rejects a batch where the operation count exceeds MAX_OPERATIONS via schema", () => {
    const ops = makeOps(21);
    const r = parseReviewResult(raw(doc({ operations: ops })));
    expect(r).toBeNull();
    // Cross-check against the Task 1 schema directly.
    const result = ReviewResultSchema.safeParse(doc({ operations: ops }));
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// Partial / invalid operations
// ===========================================================================

describe("partial or invalid operations", () => {
  it("rejects a batch where one operation has an unknown type", () => {
    const d = doc({
      operations: [
        validCreateOp,
        { type: "explode", skillName: "x" } as unknown as SkillOperation,
      ],
    });
    const r = parseReviewResult(raw(d));
    expect(r).toBeNull();
  });

  it("rejects a batch where one operation has an unknown key", () => {
    const bad = { ...validCreateOp, extra: true } as SkillOperation;
    const r = parseReviewResult(raw(doc({ operations: [bad] })));
    expect(r).toBeNull();
  });

  it("rejects a batch where one operation has an invalid skillName (traversal)", () => {
    const bad = { type: "create" as const, skillName: "../escape", content: "x" } as SkillOperation;
    const r = parseReviewResult(raw(doc({ operations: [validCreateOp, bad] })));
    expect(r).toBeNull();
  });

  it("rejects a batch where one operation has a missing required field", () => {
    const bad = { type: "create", skillName: "ok-name" } as SkillOperation; // missing content
    const r = parseReviewResult(raw(doc({ operations: [validCreateOp, bad] })));
    expect(r).toBeNull();
  });

  it("rejects a batch where one operation has an invalid path (absolute)", () => {
    const bad = {
      type: "patch" as const,
      skillName: "git-hygiene",
      path: "/etc/passwd",
      oldText: "a",
      newText: "b",
    } as SkillOperation;
    const r = parseReviewResult(raw(doc({ operations: [validCreateOp, bad] })));
    expect(r).toBeNull();
  });

  it("never exposes partial operations when any operation is invalid", () => {
    const bad = { type: "nope" as const, skillName: "x" } as unknown as SkillOperation;
    const r = parseReviewResult(raw(doc({ operations: [validCreateOp, bad] })));
    expect(r).toBeNull(); // The whole result must be null, not a partial list.
  });

  it("rejects a batch with a patch operation missing oldText", () => {
    const bad = {
      type: "patch" as const,
      skillName: "git-hygiene",
      path: "SKILL.md",
      newText: "b",
    } as SkillOperation; // missing oldText
    const r = parseReviewResult(raw(doc({ operations: [bad] })));
    expect(r).toBeNull();
  });

  it("rejects a batch with a remove_file operation missing path", () => {
    const bad = { type: "remove_file" as const, skillName: "git-hygiene" } as SkillOperation;
    const r = parseReviewResult(raw(doc({ operations: [bad] })));
    expect(r).toBeNull();
  });
});

// ===========================================================================
// Full-batch rejection for one invalid readSet entry
// ===========================================================================

describe("full-batch rejection for invalid readSet entries", () => {
  const goodEntry = {
    skillName: "git-hygiene",
    path: "SKILL.md",
    content: SKILL_MD_CONTENT,
    hash: SHA256_SKILL_MD,
  };

  it("rejects the entire result when one readSet entry has a wrong hash", () => {
    const badEntry = { ...goodEntry, hash: "deadbeef" };
    const r = parseReviewResult(
      raw(doc({ operations: [validPatchOp], readSet: [goodEntry, badEntry] })),
    );
    expect(r).toBeNull();
  });

  it("rejects the entire result when one readSet entry has an empty skillName", () => {
    const badEntry = { ...goodEntry, skillName: "" };
    const r = parseReviewResult(
      raw(doc({ operations: [validPatchOp], readSet: [badEntry] })),
    );
    expect(r).toBeNull();
  });

  it("rejects the entire result when one readSet entry has an empty path", () => {
    const badEntry = { ...goodEntry, path: "" };
    const r = parseReviewResult(
      raw(doc({ operations: [validPatchOp], readSet: [badEntry] })),
    );
    expect(r).toBeNull();
  });

  it("rejects the entire result when one readSet entry has a missing hash", () => {
    const bad = { skillName: "git-hygiene", path: "SKILL.md", content: SKILL_MD_CONTENT };
    const r = parseReviewResult(
      raw(doc({ operations: [validPatchOp], readSet: [bad] })),
    );
    expect(r).toBeNull();
  });

  it("rejects the entire result when one readSet entry has a non-string content", () => {
    const bad = { skillName: "git-hygiene", path: "SKILL.md", content: 42, hash: SHA256_SKILL_MD };
    const r = parseReviewResult(
      raw(doc({ operations: [validPatchOp], readSet: [bad] })),
    );
    expect(r).toBeNull();
  });

  it("rejects the entire result when one readSet entry has a non-string hash", () => {
    const bad = { skillName: "git-hygiene", path: "SKILL.md", content: SKILL_MD_CONTENT, hash: 999 };
    const r = parseReviewResult(
      raw(doc({ operations: [validPatchOp], readSet: [bad] })),
    );
    expect(r).toBeNull();
  });

  it("rejects the entire result when a readSet entry has an unknown key", () => {
    const bad = { ...goodEntry, secret: "should-not-be-here" };
    const r = parseReviewResult(
      raw(doc({ operations: [validPatchOp], readSet: [bad] })),
    );
    expect(r).toBeNull();
  });

  it("never exposes partial readSet when any entry is invalid", () => {
    const bad = { ...goodEntry, hash: "0".repeat(64) };
    const r = parseReviewResult(
      raw(doc({ operations: [validPatchOp], readSet: [goodEntry, bad] })),
    );
    expect(r).toBeNull();
  });

  it("accepts a valid readSet entry with a correct hash", () => {
    const r = parseReviewResult(
      raw(doc({ operations: [validPatchOp], readSet: [goodEntry] })),
    );
    expect(r).not.toBeNull();
  });
});

// ===========================================================================
// Exact string preservation
// ===========================================================================

describe("exact string preservation", () => {
  it("preserves operation content strings byte-for-byte (no normalization)", () => {
    const content = "  \t\r\n mixed  \u00a0 nbsp\n";
    const op = { type: "write_file" as const, skillName: "git-hygiene", path: "references/x.md", content };
    const r = parseReviewResult(raw(doc({ operations: [op] })));
    expect(r).not.toBeNull();
    const result = r! as ReviewResult;
    expect(result.operations[0]).toEqual(op);
    expect((result.operations[0] as { content: string }).content).toBe(content);
  });

  it("preserves skillName case exactly (no lowercasing or normalization)", () => {
    const op = { type: "create" as const, skillName: "My-Mixed-Case-Skill", content: "x" } as SkillOperation;
    const r = parseReviewResult(raw(doc({ operations: [op] })));
    // Note: skillNameSchema is case-insensitive regex but must not normalize
    expect(r).not.toBeNull();
    expect((r! as ReviewResult).operations[0].skillName).toBe("My-Mixed-Case-Skill");
  });

  it("preserves readSet content strings exactly, including trailing newlines", () => {
    const content = "alpha\nbeta\n";
    const entry = {
      skillName: "git-hygiene",
      path: "SKILL.md",
      content,
      hash: sha256(content),
    };
    const r = parseReviewResult(raw(doc({ operations: [validPatchOp], readSet: [entry] })));
    expect(r).not.toBeNull();
    const result = r! as ReviewResult;
    expect(result.readSet[0].content).toBe(content);
    expect(result.readSet[0].hash).toBe(sha256(content));
  });

  it("preserves readSet path strings exactly", () => {
    const content = "body\n";
    const entry = {
      skillName: "git-hygiene",
      path: "references/sub/deep/file.md",
      content,
      hash: sha256(content),
    };
    const r = parseReviewResult(raw(doc({ operations: [validPatchOp], readSet: [entry] })));
    expect(r).not.toBeNull();
    expect((r! as ReviewResult).readSet[0].path).toBe("references/sub/deep/file.md");
  });
});

// ===========================================================================
// Read-set hash self-consistency
// ===========================================================================

describe("read-set hash self-consistency", () => {
  it("accepts a readSet entry where hash === sha256(content)", () => {
    const content = "hello world";
    const entry = {
      skillName: "git-hygiene",
      path: "SKILL.md",
      content,
      hash: SHA256_HELLO_WORLD,
    };
    const r = parseReviewResult(raw(doc({ operations: [validPatchOp], readSet: [entry] })));
    expect(r).not.toBeNull();
  });

  it("rejects a readSet entry where hash does not equal sha256(content)", () => {
    const content = "hello world";
    const entry = {
      skillName: "git-hygiene",
      path: "SKILL.md",
      content,
      hash: "0".repeat(64), // not sha256("hello world")
    };
    const r = parseReviewResult(raw(doc({ operations: [validPatchOp], readSet: [entry] })));
    expect(r).toBeNull();
  });

  it("rejects a readSet entry where hash is the correct length but wrong value", () => {
    const content = "hello world";
    // Flip one nibble of the known-correct SHA-256.
    const wrong = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde95";
    const entry = { skillName: "git-hygiene", path: "SKILL.md", content, hash: wrong };
    const r = parseReviewResult(raw(doc({ operations: [validPatchOp], readSet: [entry] })));
    expect(r).toBeNull();
  });

  it("rejects a readSet entry with a hash of the wrong length", () => {
    const entry = {
      skillName: "git-hygiene",
      path: "SKILL.md",
      content: "x",
      hash: "abc123", // 6 chars, not 64
    };
    const r = parseReviewResult(raw(doc({ operations: [validPatchOp], readSet: [entry] })));
    expect(r).toBeNull();
  });

  it("rejects a readSet entry with a non-hex hash", () => {
    const entry = {
      skillName: "git-hygiene",
      path: "SKILL.md",
      content: "x",
      hash: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    };
    const r = parseReviewResult(raw(doc({ operations: [validPatchOp], readSet: [entry] })));
    expect(r).toBeNull();
  });

  it("accepts an empty-content readSet entry with the empty-string hash", () => {
    const entry = {
      skillName: "git-hygiene",
      path: "SKILL.md",
      content: "",
      hash: SHA256_EMPTY,
    };
    const r = parseReviewResult(raw(doc({ operations: [validPatchOp], readSet: [entry] })));
    expect(r).not.toBeNull();
  });

  it("rejects an empty-content readSet entry with a non-empty-string hash", () => {
    const entry = {
      skillName: "git-hygiene",
      path: "SKILL.md",
      content: "",
      hash: SHA256_HELLO_WORLD, // hash of "hello world", not of ""
    };
    const r = parseReviewResult(raw(doc({ operations: [validPatchOp], readSet: [entry] })));
    expect(r).toBeNull();
  });
});

// ===========================================================================
// Secret-safe error messages — lastParseError (the real failure channel)
//
// parseReviewResult never throws: every failure returns null and records a
// structured, secret-safe reason in the module-level `lastParseError` export.
// The tests below therefore call failing inputs, read `lastParseError`
// immediately, and assert it is non-null, structurally useful, and free of any
// secret / content / raw-payload value.
// ===========================================================================

describe("secret-safe error messages (lastParseError)", () => {
  const SECRET = "AKIA1234567890EXAMPLE"; // simulated credential

  /** Assert the structural, secret-free shape of a recorded failure reason. */
  function assertSecretSafe(reason: string | null): void {
    expect(reason).not.toBeNull();
    const msg = reason as string;
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain("AKIA");
    // Structured and structurally useful: fixed prefix + a non-empty schema
    // code or reason, not a raw payload echo. Bounded length.
    expect(msg).toMatch(/^invalid response: /);
    expect(msg).not.toMatch(/^invalid response: \s*$/);
    expect(msg.length).toBeLessThan(500);
  }

  it("records a secret-free reason when the raw output is not a single JSON object", () => {
    // The raw output embeds the secret only inside a fence that makes the
    // response ambiguous (two documents) → extraction fails.
    const d = { summary: `summary with ${SECRET}`, outcome: "saved", operations: [], readSet: [] };
    const r = parseReviewResult(`${raw(d)}\n\`\`\`json\n${raw(d)}\n\`\`\``);
    expect(r).toBeNull();
    assertSecretSafe(lastParseError);
  });

  it("records a secret-free reason when the schema validation fails", () => {
    // A secret-bearing summary (non-empty, so it passes min(1)) is rejected
    // only because an unknown key is present → strict-schema failure path.
    const badDoc = { ...doc({}), bogus: `token=${SECRET}` };
    const r = parseReviewResult(raw(badDoc));
    expect(r).toBeNull();
    assertSecretSafe(lastParseError);
    // Structurally useful: the reason carries the schema code, not the value.
    expect(lastParseError).toContain("(unrecognized_keys)");
    expect(lastParseError).not.toContain(SECRET);
  });

  it("does not leak readSet file content or its secret into lastParseError", () => {
    const sensitiveContent = `top-secret-token: ${SECRET}`;
    const d = doc({
      operations: [validPatchOp],
      readSet: [
        {
          skillName: "git-hygiene",
          path: "SKILL.md",
          content: sensitiveContent,
          hash: "0".repeat(64), // wrong hash → rejection (hash mismatch)
        },
      ],
    });
    const r = parseReviewResult(raw(d));
    expect(r).toBeNull();
    assertSecretSafe(lastParseError);
    expect(lastParseError).not.toContain(sensitiveContent);
  });

  it("does not echo a huge summary payload into lastParseError", () => {
    const hugePayload = "A".repeat(10000);
    // summary with trailing content still parses the object; force a strict
    // schema failure by adding an unknown key alongside the big value.
    const d = { ...doc({ summary: hugePayload }), bogus: `secret=${SECRET}` };
    const r = parseReviewResult(raw(d));
    expect(r).toBeNull();
    assertSecretSafe(lastParseError);
    expect(lastParseError).not.toContain(hugePayload);
  });

  it("records the same secret-free reason for identical invalid inputs (determinism)", () => {
    const d = doc({ summary: "" });
    const input = raw(d);
    parseReviewResult(input);
    const m1 = lastParseError;
    parseReviewResult(input);
    const m2 = lastParseError;
    expect(m1).toBe(m2);
    assertSecretSafe(m1);
  });

  it("resets lastParseError to null after a successful parse", () => {
    parseReviewResult(raw(doc({})));
    expect(lastParseError).toBeNull();
  });
});

// ===========================================================================
// Deterministic repeated parses
// ===========================================================================

describe("deterministic repeated parses", () => {
  it("returns deep-equal results for the same raw input", () => {
    const input = raw(doc({}));
    const a = parseReviewResult(input);
    const b = parseReviewResult(input);
    expect(a).toEqual(b);
  });

  it("returns identical results for the same fenced input", () => {
    const input = `\`\`\`json\n${raw(doc({}))}\n\`\`\``;
    const a = parseReviewResult(input);
    const b = parseReviewResult(input);
    expect(a).toEqual(b);
  });

  it("returns null deterministically for the same invalid input", () => {
    const input = "not json at all";
    const a = parseReviewResult(input);
    const b = parseReviewResult(input);
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it("is idempotent: parsing the same valid input twice yields the same shape", () => {
    const content = "deterministic\ncontent\n";
    const entry = { skillName: "git-hygiene", path: "SKILL.md", content, hash: sha256(content) };
    const input = raw(doc({ operations: [validPatchOp], readSet: [entry] }));
    const a = parseReviewResult(input);
    const b = parseReviewResult(input);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toEqual(b);
    // Structural identity: same operation order, same readSet order.
    expect((a! as ReviewResult).operations[0]).toEqual((b! as ReviewResult).operations[0]);
    expect((a! as ReviewResult).readSet[0]).toEqual((b! as ReviewResult).readSet[0]);
  });

  it("does not mutate the returned object across repeated parses", () => {
    const input = raw(doc({}));
    const a = parseReviewResult(input)! as ReviewResult;
    const b = parseReviewResult(input)! as ReviewResult;
    a.summary = "mutated";
    a.operations.push({ type: "archive", skillName: "sneaky" } as SkillOperation);
    expect((b as ReviewResult).summary).toBe("A verified lesson about deterministic test repair.");
    expect(b.operations).toHaveLength(1);
  });
});
