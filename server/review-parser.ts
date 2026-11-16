import { z } from "zod";

import {
  MAX_OPERATIONS,
  ReviewOutcomeSchema,
  SkillOperationSchema,
} from "./contracts";
import { sha256 } from "./skill-files";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A read-before-write evidence entry: the exact content read, plus its hash. */
export interface ReadSetEntry {
  skillName: string;
  path: string;
  content: string;
  hash: string;
}

/**
 * A validated curator review result: the structured document plus a verified
 * read set. Extends the base `ReviewResult` shape with `readSet`.
 *
 * Aliased as `ReviewResult` so existing contracts.ts importers keep working;
 * the returned type is the full document including readSet.
 */
export type ReviewResult = import("./contracts").ReviewResult & {
  readSet: ReadSetEntry[];
};

/** Internal working name for the parsed document. */
type ParsedReviewResult = ReviewResult;

// ---------------------------------------------------------------------------
// Internal schemas (readSet evidence is verified, not part of the core result)
// ---------------------------------------------------------------------------

const readSetEntrySchema = z
  .object({
    skillName: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
    hash: z.string().min(1),
  })
  .strict();

const parsedDocSchema = z
  .object({
    summary: z.string().min(1),
    outcome: ReviewOutcomeSchema,
    operations: z.array(SkillOperationSchema).max(MAX_OPERATIONS),
    readSet: z.array(readSetEntrySchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Extraction: exactly one plain JSON object, or one fenced json object
// ---------------------------------------------------------------------------

/**
 * Extract the single JSON document from the raw model output.
 *
 * Accepts exactly one of:
 *  - a plain JSON object: the entire trimmed response is a JSON object, with
 *    nothing (other than whitespace) before or after it.
 *  - a fenced JSON object: the entire trimmed response is a single `json`
 *    fenced code block (case-insensitive tag) containing one JSON object,
 *    with only whitespace outside the fences.
 *
 * Rejects (returns null): prose anywhere around the document, more than one
 * document or fence, a fenced block with any non-JSON language tag, and any
 * non-object JSON value.
 *
 * @returns the raw JSON document string, or null if the response does not
 *   contain exactly one JSON object in a valid form.
 */
function extractJsonDocument(rawInput: string): string | null {
  const text = rawInput;
  if (text.trim().length === 0) return null;

  // Case 1: fenced blocks. Find every markdown fence. A valid fenced block is
  // a balanced ``` opener (optionally tagged) paired with a ``` closer; any
  // ``` not part of such a pair makes the response ambiguous → reject.
  const fences: Array<{ tag: string; start: number; bodyStart: number; close: number }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf("```", i);
    if (idx === -1) break;
    // Determine the tag: a single optional newline, then identifier chars.
    let bodyStart = idx + 3;
    if (bodyStart < text.length && text[bodyStart] === "\n") bodyStart++;
    let tag = "";
    let j = bodyStart;
    while (j < text.length && /[a-zA-Z0-9]/.test(text[j])) {
      tag += text[j];
      j++;
    }
    if (j > bodyStart) bodyStart = j;
    const close = text.indexOf("```", bodyStart);
    if (close === -1) {
      // Unclosed fence → ambiguous; cannot be the single fenced document.
      return null;
    }
    fences.push({ tag, start: idx, bodyStart, close });
    i = close + 3;
  }

  if (fences.length > 0) {
    // Any fence present: the response must be exactly one fenced block, with
    // whitespace-only outside it.
    if (fences.length !== 1) return null;
    const f = fences[0];
    if (f.tag.toLowerCase() !== "json") return null;
    const before = text.slice(0, f.start);
    const after = text.slice(f.close + 3);
    if (before.trim().length !== 0) return null;
    if (after.trim().length !== 0) return null;
    const body = text.slice(f.bodyStart, f.close);
    if (body.trim().length === 0) return null;
    const r = verifySingleObject(body);
    return r.ok === "object" ? r.json : null;
  }

  // Case 2: no fences → must be a single plain JSON object, whitespace-only
  // surrounding. Verify by parsing and checking no non-whitespace follows.
  const r = verifySingleObject(text);
  return r.ok === "object" ? r.json : null;
}

type ExtractResult =
  | { ok: "object"; json: string }
  | { ok: "non-object" }
  | { ok: "trailing" }
  | { ok: "parse-error" };

function verifySingleObject(text: string): ExtractResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: "parse-error" };
  if (!trimmed.startsWith("{")) return { ok: "non-object" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: "parse-error" };
  }

  // A non-object JSON value (array, string, number, null, boolean) → reject.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: "non-object" };
  }

  // The entire trimmed response must be the object: any non-whitespace after
  // the first complete value means a second document follows.
  const end = findObjectEnd(trimmed);
  if (end === -1) return { ok: "parse-error" };
  const remainder = trimmed.slice(end);
  if (remainder.trim().length !== 0) return { ok: "trailing" };

  // Canonical round-trip: re-serialize to guarantee a single object with no
  // duplicate keys and to normalize the whitespace around it.
  const reserialized = JSON.stringify(parsed);
  return { ok: "object", json: reserialized };
}

/**
 * Index (exclusive) of the closing brace of the top-level object, assuming the
 * string is a valid JSON object. Returns -1 if not found.
 */
function findObjectEnd(s: string): number {
  if (s[0] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a curator agent's raw review output into a validated `ReviewResult`.
 *
 * Accepts exactly one plain JSON object, or one fenced `json` object, with no
 * surrounding prose or second document. Validates against
 * `ReviewResultSchema` (Task 1) plus read-set hash self-consistency, and
 * returns a structured `ParsedReviewResult` with the readSet verified.
 *
 * @param raw the raw model output string.
 * @returns the validated result, or `null` if the response is ambiguous,
 *   non-object, malformed, or fails any schema/hash check. Never throws; all
 *   failures are reported via the `ParseFailure`-shaped `null` plus a
 *   structured, secret-safe reason recorded in `lastParseError`.
 */
export function parseReviewResult(
  raw: string,
): ParsedReviewResult | null {
  lastParseError = null;

  const jsonDoc = extractJsonDocument(raw);
  if (jsonDoc === null) {
    lastParseError =
      "invalid response: expected exactly one JSON object (plain or fenced)";
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonDoc);
  } catch {
    lastParseError = "invalid response: JSON document failed to parse";
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    lastParseError = "invalid response: JSON document is not an object";
    return null;
  }

  // Schema validation (core + readSet), strict.
  const result = parsedDocSchema.safeParse(parsed);
  if (!result.success) {
    lastParseError = describeSchemaFailure(result.error);
    return null;
  }

  // Read-set hash self-consistency: every entry's hash must equal
  // sha256(content). A mismatch means the agent lied about what it read, so
  // the whole batch is rejected (no partial readSet is exposed).
  for (const entry of result.data.readSet) {
    const actual = sha256(entry.content);
    if (actual !== entry.hash) {
      lastParseError =
        "invalid response: readSet hash does not match content";
      return null;
    }
  }

  // Re-serialize the readSet entries to plain objects (no zod metadata) so
  // the returned value is a stable, deterministic structure.
  return {
    summary: result.data.summary,
    outcome: result.data.outcome,
    operations: result.data.operations,
    readSet: result.data.readSet.map((e) => ({
      skillName: e.skillName,
      path: e.path,
      content: e.content,
      hash: e.hash,
    })),
  };
}

/**
 * A structured, secret-safe description of a zod parse failure. Never echoes
 * the raw input or any field value — only the structural shape of the error.
 */
function describeSchemaFailure(error: z.ZodError): string {
  const issues = error.issues;
  if (issues.length === 0) {
    return "invalid response: failed schema validation (no issues)";
  }
  // Describe the first issue structurally: path + code, no message value.
  const first = issues[0];
  const path = first.path.join("/");
  return `invalid response: schema validation failed at "${path}" (${first.code})`;
}

/**
 * The last parse failure reason, or `null` if the most recent parse
 * succeeded. Structured and secret-safe: never contains the raw input or any
 * field value. Useful for logging without leaking sensitive content.
 */
export let lastParseError: string | null = null;
