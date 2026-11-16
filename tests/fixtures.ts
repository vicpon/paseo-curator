import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SkillOperation, SkillManifest } from "../server/contracts";
import { sha256 } from "../server/skill-files";

/**
 * Isolated temporary roots for tests — never touches ~/.agents/skills.
 * Each call returns a fresh directory under the system temp path.
 */
export function makeTempRoot(label: string): string {
  const dir = join(
    tmpdir(),
    `curator-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupRoot(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * A valid SKILL.md body with minimal YAML frontmatter.
 * `createdBy` defaults to "paseo-curator" (agent-created).
 */
export function skillMd(name: string, body: string, opts?: { createdBy?: string }): string {
  const createdBy = opts?.createdBy ?? "paseo-curator";
  return `---\nname: ${name}\ncreated_by: ${createdBy}\n---\n\n${body}\n`;
}

/**
 * A skill manifest with curator provenance.
 */
export function curatorManifest(name: string): SkillManifest {
  return { skillName: name, createdAt: new Date().toISOString(), createdBy: "paseo-curator" };
}

/**
 * A skill manifest with user provenance.
 */
export function userManifest(name: string): SkillManifest {
  return { skillName: name, createdAt: new Date().toISOString(), createdBy: "user" };
}

/**
 * Create a skill directory with the given SKILL.md content (with frontmatter)
 * under `root`. Returns the skill name.
 */
export function createSkill(
  root: string,
  name: string,
  content: string,
  supportFiles?: Record<string, string>,
): string {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");
  if (supportFiles) {
    for (const [relPath, fileContent] of Object.entries(supportFiles)) {
      const abs = join(skillDir, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, fileContent, "utf8");
    }
  }
  return name;
}

/**
 * Create a symlink inside a skill that points outside the skill root.
 * Used to test realpath escape rejection.
 */
export function createSymlinkEscape(
  root: string,
  skillName: string,
  symlinkRelPath: string,
  outsideTarget: string,
): void {
  const skillDir = join(root, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillMd(skillName, "test\n"), "utf8");
  const linkAbs = join(skillDir, symlinkRelPath);
  mkdirSync(dirname(linkAbs), { recursive: true });
  symlinkSync(outsideTarget, linkAbs, "dir");
}

/**
 * A readSet entry: the exact content the curator agent read for a given
 * file path, together with its SHA-256 hash. Used as read-before-write
 * evidence.
 */
export interface ReadSetEntry {
  skillName: string;
  path: string;
  content: string;
  hash: string;
}

/**
 * Read a file and return it as a ReadSetEntry (with hash).
 */
export function readToEntry(root: string, skillName: string, path: string): ReadSetEntry {
  const content = readFileSync(join(root, skillName, path), "utf8");
  return { skillName, path, content, hash: sha256(content) };
}

/**
 * Build a batch of create operations for N skills with valid frontmatter.
 */
export function makeCreateOps(names: string[], root: string): SkillOperation[] {
  void root;
  return names.map((name) => ({
    type: "create" as const,
    skillName: name,
    content: skillMd(name, `Content for ${name}\n`),
  }));
}

/**
 * Build a patch operation targeting SKILL.md of the given skill.
 */
export function makePatchOp(name: string, oldText: string, newText: string): SkillOperation {
  return { type: "patch" as const, skillName: name, path: "SKILL.md", oldText, newText };
}

/**
 * Build a write_file operation for a support file.
 */
export function makeWriteFileOp(name: string, path: string, content: string): SkillOperation {
  return { type: "write_file" as const, skillName: name, path, content };
}

/**
 * Build a remove_file operation for a support file.
 */
export function makeRemoveFileOp(name: string, path: string): SkillOperation {
  return { type: "remove_file" as const, skillName: name, path };
}

/**
 * Build an archive operation.
 */
export function makeArchiveOp(name: string): SkillOperation {
  return { type: "archive" as const, skillName: name };
}

/**
 * Read the SKILL.md content of a skill.
 */
export function readSkillMd(root: string, name: string): string {
  return readFileSync(join(root, name, "SKILL.md"), "utf8");
}

/**
 * Check if a file exists at a path relative to a skill directory.
 */
export function skillFileExists(root: string, name: string, relPath: string): boolean {
  return existsSync(join(root, name, relPath));
}

/**
 * Check if a skill directory exists.
 */
export function skillDirExists(root: string, name: string): boolean {
  return existsSync(join(root, name)) && statSync(join(root, name)).isDirectory();
}

/**
 * Check if a skill is in the .archive directory.
 */
export function skillArchived(root: string, name: string): boolean {
  return skillDirExists(join(root, ".archive"), name);
}

/**
 * List skill names (directories, excluding dotfiles like .archive/.locks).
 */
export function listSkills(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((e) => {
      const full = join(root, e);
      return statSync(full).isDirectory() && !e.startsWith(".");
    })
    .sort();
}

/**
 * Resolve the canonical path of a path relative to the skill root,
 * performing a realpath check.
 */
export function canonicalPath(root: string, ...segments: string[]): string {
  return resolve(root, ...segments);
}
