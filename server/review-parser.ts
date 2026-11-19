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
    // Advisory only. The authoritative read-before-write proof is the locked
    // filesystem snapshot taken inside SkillManager.applyBatch; a model that
    // paraphrases or truncates a long SKILL.md (which the read tools do) must
    // not doom an otherwise valid batch.
    readSet: z.array(readSetEntrySchema).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Extraction: exactly one plain JSON object, or one fenced json object
// ---------------------------------------------------------------------------

/**
 * True when `text` (the prose outside the single fenced block) contains a
 * complete, balanced top-level JSON object. Such text is a second candidate
 * document, not chatter — the response is ambiguous and must be rejected.
 */
function containsCompleteJsonObject(text: string): boolean {
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    const candidate = text.slice(i);
    const r = verifySingleObject(candidate);
    if (r.ok === "object" || r.ok === "non-object") {
      // A structurally-complete value starts at this "{". Only a complete
      // object counts as a second document; a non-object value (e.g. an
      // array in prose) is chatter, not a rival review document.
      if (r.ok === "object") return true;
      return false;
    }
    // parse-error / trailing: try the next "{".
  }
  return false;
}

/**
 * Extract the single JSON document from the raw model output.
 *
 * Accepts exactly one of:
 *  - a plain JSON object: the entire trimmed response is a JSON object, with
 *    nothing (other than whitespace) before or after it. Parsing is
 *    string-aware, so markdown fences inside JSON string values (skill
 *    bodies are full of code fences) do not disturb it. This case is tried
 *    first for exactly that reason.
 *  - a fenced JSON object: the first fence carries a `json` tag
 *    (case-insensitive) and the body extends to the LAST fence marker in
 *    the response, so fences embedded inside JSON string values remain part
 *    of the body. Surrounding prose is tolerated as model chatter, provided
 *    the prose does not itself contain a complete JSON object (which would
 *    make the document ambiguous) or a second genuine fenced document.
 *
 * Rejects (returns null): a non-JSON first fence tag, a body that is not
 * exactly one JSON object (including a second fenced document after the
 * first), prose containing a complete second JSON object, and any
 * non-object JSON value.
 *
 * @returns the raw JSON document string, or null if the response does not
 *   contain exactly one JSON object in a valid form.
 */
function extractJsonDocument(rawInput: string): string | null {
  const text = rawInput;
  if (text.trim().length === 0) return null;

  // Case 1: the response IS a plain JSON object (possibly with fences
  // embedded inside its string values). String-aware verification means
  // embedded ``` sequences never break this path.
  const trimmedStartsObject = text.trimStart().startsWith("{");
  if (trimmedStartsObject) {
    const r = verifySingleObject(text);
    if (r.ok === "object") return r.json;
    // A complete object followed by more content falls through to the
    // fence logic: the trailing content may be chatter after a fenced
    // document, or an ambiguity the guards below will reject.
  }

  // Case 2: fenced blocks. The document fence is the FIRST fence in the
  // response; its body extends to the LAST fence marker, so fences inside
  // JSON string values stay in the body.
  const firstFence = text.indexOf("```");
  if (firstFence === -1) return null;

  // The tag: identifier characters immediately after the opener.
  let bodyStart = firstFence + 3;
  if (bodyStart < text.length && text[bodyStart] === "\n") bodyStart++;
  let tag = "";
  let j = bodyStart;
  while (j < text.length && /[a-zA-Z0-9]/.test(text[j])) {
    tag += text[j];
    j++;
  }
  if (j > bodyStart) bodyStart = j;
  if (tag.toLowerCase() !== "json") return null;

  const lastFence = text.lastIndexOf("```");
  if (lastFence <= firstFence) return null; // unclosed fence
  const body = text.slice(bodyStart, lastFence);
  if (body.trim().length === 0) return null;

  // Prose outside the block must not contain a complete rival JSON object.
  const before = text.slice(0, firstFence);
  const after = text.slice(lastFence + 3);
  if (containsCompleteJsonObject(before) || containsCompleteJsonObject(after)) {
    return null;
  }

  const r = verifySingleObject(body);
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
 * Accepts exactly one plain JSON object, or exactly one fenced `json` object
 * with prose chatter around it (as long as the prose contains no complete
 * second JSON object). Validates against `ReviewResultSchema` (Task 1) plus
 * read-set hash self-consistency, and returns a structured
 * `ParsedReviewResult` with the readSet verified.
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

  // Read-set is advisory: normalize each entry's hash to its own content so a
  // downstream consumer can never trust a model-supplied digest it did not
  // verify. A self-inconsistent entry is dropped, not fatal — the batch's real
  // safety comes from the locked snapshot in SkillManager.
  const readSet = (result.data.readSet ?? []).flatMap((entry) => {
    const actual = sha256(entry.content);
    return actual === entry.hash
      ? [{ skillName: entry.skillName, path: entry.path, content: entry.content, hash: actual }]
      : [];
  });

  return {
    summary: result.data.summary,
    outcome: result.data.outcome,
    operations: result.data.operations,
    readSet,
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
