import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// ===========================================================================
// Errors
// ===========================================================================

/** Thrown when a path operation would escape the skill root. */
export class PathEscapeError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly root: string,
    message?: string,
  ) {
    super(
      message ?? `Path escapes skill root: "${attemptedPath}" is outside "${root}"`,
    );
    this.name = "PathEscapeError";
  }
}

/** Thrown when a skill name is malformed (traversal, absolute, leading dot). */
export class InvalidSkillNameError extends Error {
  constructor(
    public readonly skillName: string,
    message?: string,
  ) {
    super(message ?? `Invalid skill name: "${skillName}"`);
    this.name = "InvalidSkillNameError";
  }
}

/** Thrown when SKILL.md frontmatter is missing or malformed. */
export class FrontmatterError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly reason: string,
  ) {
    super(`Invalid frontmatter for skill "${skillName}": ${reason}`);
    this.name = "FrontmatterError";
  }
}

// ===========================================================================
// Hashing
// ===========================================================================

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ===========================================================================
// Path canonicalization and containment
// ===========================================================================

/**
 * Validate a skill name at the filesystem level.
 *
 * Rejects: absolute paths, leading dots, path separators, `..` segments, and
 * anything that is not a slug of alphanumerics and hyphens. A skill name is
 * a single path segment, never a path.
 */
export function validateSkillName(skillName: string): void {
  if (skillName.length === 0 || skillName.length > 128) {
    throw new InvalidSkillNameError(skillName, "skill name must be 1-128 characters");
  }
  if (skillName.startsWith(".")) {
    throw new InvalidSkillNameError(skillName, "skill name must not start with a dot");
  }
  if (isAbsolute(skillName) || skillName.includes(sep) || skillName.includes("/") || skillName.includes("\\")) {
    throw new InvalidSkillNameError(skillName, "skill name must not contain path separators");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(skillName)) {
    throw new InvalidSkillNameError(skillName, "skill name must be a slug of alphanumerics and hyphens");
  }
}

/**
 * Resolve `relPath` against the skill directory of `skillName` under `root`,
 * and verify the result (logical and real) stays within the canonical root.
 *
 * Returns the canonical absolute path.
 *
 * Rejects:
 *  - absolute or `..`-containing paths (logical escape),
 *  - paths whose real (symlink-resolved) location is outside the real root
 *    (symlink escape), checking the deepest existing ancestor for not-yet-
 *    created targets.
 */
export function resolveSkillPath(root: string, skillName: string, relPath: string): string {
  validateSkillName(skillName);

  const rootAbs = resolve(root);

  if (isAbsolute(relPath)) {
    throw new PathEscapeError(relPath, rootAbs, "absolute path");
  }
  if (relPath.length === 0) {
    throw new PathEscapeError(relPath, rootAbs, "empty path");
  }
  if (relPath.includes("..")) {
    throw new PathEscapeError(relPath, rootAbs, "path contains '..'");
  }

  const candidate = join(rootAbs, skillName, relPath);
  const normalized = resolve(candidate);

  // Logical containment: normalized must be strictly inside rootAbs.
  const rel = relative(rootAbs, normalized);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapeError(candidate, rootAbs);
  }

  // Real-path containment: resolve symlinks on the deepest existing
  // ancestor and verify it stays within the real root.
  verifyContained(root, normalized);

  return normalized;
}

/**
 * Verify that `absPath`'s deepest existing ancestor stays physically inside
 * the real skill root. Fails closed on any escape.
 *
 * This is the write-time containment check (F-2): before every file
 * create/write/remove and directory move, callers MUST re-resolve the
 * target's deepest existing ancestor with `realpathSync` and confirm it is
 * still inside the canonical real root. A symlink swapped into place between
 * the preflight/snapshot check and the write causes this to throw.
 *
 * `root` is canonically resolved once; the check is a no-op pass for paths
 * that do not yet exist (the deepest existing ancestor is the skill root
 * itself, which always passes).
 *
 * @param root - the skill root (canonical or not; it is resolved internally)
 * @param absPath - the absolute path to verify
 * @throws {PathEscapeError} when the real location escapes the root
 */
export function verifyContained(root: string, absPath: string): void {
  const realRoot = realpathOrSelf(resolve(root));
  const realAncestor = resolveAncestorRealPath(resolve(absPath), realRoot);
  const rel = relative(realRoot, realAncestor);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapeError(absPath, root, "symlink escape detected at write time");
  }
}

/**
 * Walk up from `p` until an existing path is found, resolve its real path,
 * then re-append the non-existent suffix. This catches symlink escapes on
 * create targets where the file does not exist yet but its parent directory
 * is a symlink pointing outside the root.
 */
function resolveAncestorRealPath(p: string, realRoot: string): string {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) {
      const real = realpathOrSelf(cur);
      const rel = relative(realRoot, real);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new PathEscapeError(p, realRoot, "symlink escape detected");
      }
      const suffix = p.slice(cur.length);
      return join(real, suffix);
    }
    const parent = dirname(cur);
    if (parent === cur) {
      // Reached filesystem root without finding an existing ancestor.
      return p;
    }
    cur = parent;
  }
}

/** fs.realpathSync that does not throw; returns input if unresolvable. */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ===========================================================================
// Locking
// ===========================================================================

/**
 * A per-skill mutex backed by a lock directory.
 *
 * Acquired with `mkdir` (atomic on POSIX), released with `rm -r`. Lock
 * directories live at `<root>/.locks/<skillName>/`. Deadlock avoidance is
 * the caller's job: always acquire in stable (sorted) order via
 * {@link acquireSkillLocks}.
 */
export class SkillLock {
  private lockDir: string;
  private acquired = false;

  constructor(
    private readonly root: string,
    public readonly skillName: string,
  ) {
    this.lockDir = join(root, ".locks", skillName);
  }

  /**
   * Acquire the lock, waiting with bounded retries on contention.
   */
  async acquire(timeoutMs: number = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        mkdirSync(this.lockDir);
        this.acquired = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          if (Date.now() >= deadline) {
            throw new Error(
              `Lock timeout: could not acquire lock for "${this.skillName}" within ${timeoutMs}ms`,
            );
          }
          await sleep(10);
          continue;
        }
        throw e;
      }
    }
  }

  /** Release the lock. Idempotent. */
  release(): void {
    if (this.acquired) {
      rmSync(this.lockDir, { recursive: true, force: true });
      this.acquired = false;
    }
  }
}

/**
 * Acquire locks for all given skill names in stable (lexicographic) order to
 * avoid deadlock. Returns the locks in acquisition order. On failure, any
 * locks already acquired are released before the error propagates.
 */
export async function acquireSkillLocks(
  root: string,
  skillNames: string[],
  timeoutMs?: number,
): Promise<SkillLock[]> {
  const sorted = [...new Set(skillNames)].sort();
  const locks: SkillLock[] = [];
  try {
    mkdirSync(join(root, ".locks"), { recursive: true });
    for (const name of sorted) {
      const lock = new SkillLock(root, name);
      await lock.acquire(timeoutMs);
      locks.push(lock);
    }
    return locks;
  } catch (e) {
    for (const l of locks) l.release();
    throw e;
  }
}

/** Release a set of locks in reverse acquisition order. */
export function releaseSkillLocks(locks: SkillLock[]): void {
  for (const l of locks.reverse()) l.release();
}

// ===========================================================================
// Snapshots
// ===========================================================================

/**
 * An immutable snapshot of a skill directory: every file (recursively) with
 * its exact content, plus a record of symlinks. A pure data structure with no
 * file handles, safe to hold for the entire apply phase.
 */
export interface SkillSnapshot {
  skillName: string;
  /** Whether the skill directory existed at snapshot time. */
  existed: boolean;
  /** Relative path → exact file content. */
  files: Map<string, string>;
  /** Relative path → symlink target (for symlink entries). */
  symlinks: Map<string, string>;
  /** SHA-256 of each file's content, keyed by relative path. */
  hashes: Map<string, string>;
}

/**
 * Restore a skill directory from its snapshot.
 *
 * Safety: before any traversal, `lstat` the skill root. If it is a symlink
 * (e.g. replaced after snapshot), remove the link itself without following
 * it, then recreate the real directory before restoring. Verify containment
 * before every removal/write/symlink creation so no restore action can
 * escape the skill root. Failures are recorded in `errors`, feeding the
 * `rollback_failed` outcome.
 */
export function restoreSkill(
  root: string,
  snapshot: SkillSnapshot,
): { restored: string[]; removed: string[]; errors: string[] } {
  const skillDir = join(root, snapshot.skillName);
  const restored: string[] = [];
  const removed: string[] = [];
  const errors: string[] = [];

  const rootStat = safeLstat(skillDir);

  if (!snapshot.existed) {
    if (rootStat === null) {
      return { restored, removed, errors };
    }
    // The skill root may have been replaced with a symlink pointing outside
    // the configured root. Remove the link itself without following it, so
    // no outside file is touched. Then remove the (possibly recreated)
    // directory and return — the skill did not exist in the snapshot.
    if (rootStat.isSymbolicLink()) {
      try {
        rmSync(skillDir); // remove the link itself, not the target
      } catch (e) {
        errors.push(`${snapshot.skillName}: failed to remove root symlink: ${errMsg(e)}`);
      }
    }
    if (existsSync(skillDir)) {
      try {
        verifyContained(root, skillDir);
        rmSync(skillDir, { recursive: true, force: true });
        removed.push(snapshot.skillName);
      } catch (e) {
        errors.push(`${snapshot.skillName}: ${errMsg(e)}`);
      }
    }
    return { restored, removed, errors };
  }

  // If the skill root is a symlink, it points outside the skill root.
  // Remove the link itself (never follow it), then recreate the real
  // directory before any restore traversal.
  if (rootStat !== null && rootStat.isSymbolicLink()) {
    try {
      rmSync(skillDir); // remove the link itself, not the target
    } catch (e) {
      errors.push(`${snapshot.skillName}: failed to remove root symlink: ${errMsg(e)}`);
    }
  }
  if (!existsSync(skillDir)) {
    try {
      mkdirSync(skillDir, { recursive: true });
    } catch (e) {
      errors.push(`${snapshot.skillName}: failed to recreate skill directory: ${errMsg(e)}`);
    }
  }

  // Enumerate what is currently on disk (root is now a real directory).
  const current = new Map<string, { kind: "file" | "dir" | "symlink" }>();
  if (existsSync(skillDir)) {
    walkDirKinds(skillDir, "", current);
  }

  // Remove entries that exist now but were not in the snapshot.
  // Verify containment before each removal so no restore action escapes the root.
  for (const [rel] of current) {
    if (!snapshot.files.has(rel) && !snapshot.symlinks.has(rel)) {
      const abs = join(skillDir, rel);
      try {
        verifyContained(root, abs);
        rmSync(abs, { recursive: true, force: true });
        removed.push(`${snapshot.skillName}/${rel}`);
      } catch (e) {
        errors.push(`${snapshot.skillName}/${rel}: ${errMsg(e)}`);
      }
    }
  }

  // Remove symlinks that were in the snapshot but are now something else,
  // and restore snapshot symlinks.
  for (const [rel, target] of snapshot.symlinks) {
    const abs = join(skillDir, rel);
    try {
      verifyContained(root, abs);
      if (existsSync(abs) || lstatSync(abs).isSymbolicLink()) {
        rmSync(abs, { recursive: true, force: true });
      }
      mkdirSync(dirname(abs), { recursive: true });
      // Re-create the symlink. If symlink creation fails for platform
      // reasons, fail the restore loudly (recorded in `errors`) rather than
      // silently substituting a regular file whose content is the target
      // string — that would corrupt skill state.
      symlinkSync(target, abs);
      restored.push(`${snapshot.skillName}/${rel}`);
    } catch (e) {
      errors.push(`${snapshot.skillName}/${rel}: ${errMsg(e)}`);
    }
  }

  // Write back every snapshot file. Verify containment before each write.
  for (const [rel, content] of snapshot.files) {
    const abs = join(skillDir, rel);
    try {
      verifyContained(root, abs);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      restored.push(`${snapshot.skillName}/${rel}`);
    } catch (e) {
      errors.push(`${snapshot.skillName}/${rel}: ${errMsg(e)}`);
    }
  }

  return { restored, removed, errors };
}

/** Safe lstat: returns the stats, or `null` if the path does not exist. */
function safeLstat(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Snapshot a skill directory by reading every file into memory.
 */
export function snapshotSkill(root: string, skillName: string): SkillSnapshot {
  const skillDir = join(root, skillName);
  if (!existsSync(skillDir)) {
    return { skillName, existed: false, files: new Map(), symlinks: new Map(), hashes: new Map() };
  }
  const files = new Map<string, string>();
  const symlinks = new Map<string, string>();
  const hashes = new Map<string, string>();
  walkDir(skillDir, "", files, symlinks, hashes);
  return { skillName, existed: true, files, symlinks, hashes };
}

/** Recursively read a directory into the maps. Symlinks are recorded, not followed. */
function walkDir(
  dir: string,
  relPrefix: string,
  files: Map<string, string>,
  symlinks: Map<string, string>,
  hashes: Map<string, string>,
): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    const abs = join(dir, entry.name);
    const lstat = lstatSync(abs);
    if (lstat.isSymbolicLink()) {
      symlinks.set(rel, readlinkSync(abs));
    } else if (lstat.isDirectory()) {
      walkDir(abs, rel, files, symlinks, hashes);
    } else if (lstat.isFile()) {
      const content = readFileSync(abs, "utf8");
      files.set(rel, content);
      hashes.set(rel, sha256(content));
    }
  }
}

/** Recursively enumerate path kinds (file/dir/symlink) under `dir`. */
function walkDirKinds(
  dir: string,
  relPrefix: string,
  out: Map<string, { kind: "file" | "dir" | "symlink" }>,
): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      out.set(rel, { kind: "symlink" });
    } else if (entry.isDirectory()) {
      out.set(rel, { kind: "dir" });
      walkDirKinds(abs, rel, out);
    } else if (entry.isFile()) {
      out.set(rel, { kind: "file" });
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ===========================================================================
// Restore seam (dependency injection for rollback testing)
// ===========================================================================

/**
 * The signature of the skill restore implementation. Production uses
 * {@link restoreSkill}; tests inject a failing implementation to prove a
 * failed rollback is surfaced loudly (F-1).
 */
export type RestoreSkillFn = (
  root: string,
  snapshot: SkillSnapshot,
) => { restored: string[]; removed: string[]; errors: string[] };

// ===========================================================================
// Atomic file operations
// ===========================================================================

/**
 * A callback invoked with the absolute temp path when a temp file has been
 * created (after the write, before the rename). The manager tracks every
 * temp path it creates so rollback can delete exactly those names — never a
 * broad glob that might match a pre-existing user dotfile (F-1).
 */
export type TempFileTracker = (tmpPath: string) => void;

/**
 * Atomically write `content` to `absPath` via a temp file in the same
 * directory + rename. Creates parent directories as needed.
 *
 * The temp file lives in the target's directory so the rename is atomic on
 * the same filesystem. The temp name is derived from `randomUUID()` plus PID
 * so it cannot collide with a pre-existing user file (F-1).
 *
 * When the rename fails (EACCES, ENOSPC, …), the temp file may survive; the
 * caller (the skill manager) is expected to pass a `trackTemp` callback so it
 * can delete exactly the temp files this process created during rollback.
 *
 * @returns the absolute path that was written.
 */
export function atomicWrite(
  absPath: string,
  content: string,
  trackTemp?: TempFileTracker,
): string {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(absPath)}.curator-tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(tmp, content, "utf8");
    trackTemp?.(tmp);
    renameSync(tmp, absPath);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup; the caller's temp tracker retains the name so
      // rollback can retry or surface the failure (F-1).
    }
    throw e;
  }
  return absPath;
}

/**
 * Atomically create `absPath` with `content`. The target must not already
 * exist (create-only semantics).
 *
 * See {@link atomicWrite} for temp-file tracking semantics.
 */
export function atomicCreate(
  absPath: string,
  content: string,
  trackTemp?: TempFileTracker,
): string {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  if (existsSync(absPath)) {
    throw new Error(`atomicCreate: target already exists: ${absPath}`);
  }
  const tmp = join(dir, `.${basename(absPath)}.curator-tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(tmp, content, "utf8");
    trackTemp?.(tmp);
    renameSync(tmp, absPath);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup; the caller's temp tracker retains the name.
    }
    throw e;
  }
  return absPath;
}

/** Remove a file or directory; idempotent. */
export function removePath(absPath: string): void {
  if (existsSync(absPath) || isSymlink(absPath)) {
    rmSync(absPath, { recursive: true, force: true });
  }
}

/** True if the path is a symlink. */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Atomically move a directory `srcDir` → `dstDir` (same filesystem rename).
 * Used by the archive operation.
 */
export function atomicMoveDir(srcDir: string, dstDir: string): void {
  const parent = dirname(dstDir);
  mkdirSync(parent, { recursive: true });
  if (existsSync(dstDir)) {
    throw new Error(`atomicMoveDir: destination already exists: ${dstDir}`);
  }
  renameSync(srcDir, dstDir);
}

// ===========================================================================
// Frontmatter
// ===========================================================================

/** A parsed YAML frontmatter block. */
export interface ParsedFrontmatter {
  name: string;
  createdBy: string | null;
  /** All keys present in the frontmatter block. */
  keys: string[];
  /** Raw frontmatter text (between the --- delimiters). */
  raw: string;
}

/**
 * Parse the YAML frontmatter from SKILL.md content.
 *
 * Returns `null` when no frontmatter block is present. Only top-level
 * `key: value` pairs are parsed (no nested YAML); this is sufficient for the
 * `name` and `created_by` fields the manager cares about.
 */
export function parseFrontmatter(content: string): { frontmatter: ParsedFrontmatter; body: string } | null {
  const lines = content.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return null;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return null;
  }
  const frontmatterLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  const raw = frontmatterLines.join("\n");

  const keys: string[] = [];
  let name = "";
  let createdBy: string | null = null;

  for (const line of frontmatterLines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    keys.push(key);
    if (key === "name") name = value;
    else if (key === "created_by") createdBy = value;
  }

  return {
    frontmatter: { name, createdBy, keys, raw },
    body,
  };
}

/**
 * Validate SKILL.md frontmatter for a `create` operation.
 *
 * Rules:
 *  - frontmatter block must be present and well-formed;
 *  - `name` must be present, non-empty, and equal to `skillName`;
 *  - `created_by` must be present and non-empty.
 */
export function validateFrontmatter(
  skillName: string,
  content: string,
  opts: { expectCreatedBy?: string } = {},
): void {
  const parsed = parseFrontmatter(content);
  if (parsed === null) {
    throw new FrontmatterError(skillName, "missing or malformed frontmatter block");
  }
  const { name, createdBy, keys } = parsed.frontmatter;
  if (name.length === 0) {
    throw new FrontmatterError(skillName, "`name` is missing or empty");
  }
  if (name !== skillName) {
    throw new FrontmatterError(
      skillName,
      `frontmatter name "${name}" does not match skill name "${skillName}"`,
    );
  }
  if (createdBy === null) {
    if (!keys.includes("created_by")) {
      throw new FrontmatterError(skillName, "`created_by` is missing");
    }
    throw new FrontmatterError(skillName, "`created_by` is empty");
  }
  if (opts.expectCreatedBy !== undefined && createdBy !== opts.expectCreatedBy) {
    throw new FrontmatterError(
      skillName,
      `created_by "${createdBy}" does not match expected "${opts.expectCreatedBy}"`,
    );
  }
}

/**
 * Provenance value the curator stamps on every skill it creates. Maintenance
 * uses it to restrict automatic archiving to curator-created skills.
 */
export const CURATOR_PROVENANCE = "paseo-curator";

/**
 * Return `content` with the frontmatter `created_by` field set to
 * {@link CURATOR_PROVENANCE}.
 *
 * Provenance is a plugin-controlled fact, never a model choice: a create
 * operation's content is stamped regardless of what the curator agent wrote
 * (missing, empty, or foreign values are all overwritten). Content without a
 * parseable frontmatter block is returned unchanged — validation elsewhere
 * rejects it.
 */
export function stampCuratorProvenance(content: string): string {
  const parsed = parseFrontmatter(content);
  if (parsed === null) return content;
  if (parsed.frontmatter.createdBy === CURATOR_PROVENANCE) return content;
  const lines = content.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return content;
  const stamped = `created_by: ${CURATOR_PROVENANCE}`;
  let replaced = false;
  for (let i = 1; i < end; i++) {
    if (/^created_by\s*:/.test(lines[i])) {
      lines[i] = stamped;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    lines.splice(end, 0, stamped);
  }
  return lines.join("\n");
}

/**
 * Validate that a patch to `SKILL.md` preserves the frontmatter: the block
 * must still parse, the `name` must be unchanged, and `created_by` must be
 * invariant — the after value must equal the before value. A skill that
 * never carried `created_by` (e.g. a pre-existing user skill) may stay
 * without one; what a patch must never do is change provenance.
 */
export function validateFrontmatterPreserved(
  skillName: string,
  before: string,
  after: string,
): void {
  const parsedAfter = parseFrontmatter(after);
  if (parsedAfter === null) {
    throw new FrontmatterError(skillName, "patch would remove the frontmatter block");
  }
  if (parsedAfter.frontmatter.name !== skillName) {
    throw new FrontmatterError(
      skillName,
      `patch would change frontmatter name from "${skillName}" to "${parsedAfter.frontmatter.name}"`,
    );
  }
  const parsedBefore = parseFrontmatter(before);
  const beforeCreatedBy = parsedBefore?.frontmatter.createdBy ?? null;
  const afterCreatedBy = parsedAfter.frontmatter.createdBy;
  if (beforeCreatedBy !== afterCreatedBy) {
    throw new FrontmatterError(
      skillName,
      `patch would change \`created_by\` from ${JSON.stringify(beforeCreatedBy)} to ${JSON.stringify(afterCreatedBy)}`,
    );
  }
}

// ===========================================================================
// Utilities
// ===========================================================================

function sleep(ms: number): Promise<void> {
  const { promise, resolve: res } = Promise.withResolvers<void>();
  setTimeout(res, ms);
  return promise;
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
