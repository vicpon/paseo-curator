import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curatorSettings } from "../shared/settings";

describe("routing settings persistence", () => {
  it("migrates explicit legacy consent, keeps None default, and discards invalid legacy values", async () => {
    expect(curatorSettings.version).toBe(2);
    expect(await curatorSettings.migrate?.({ fallbackProvider: "codex" }, 1)).toEqual({ fallbackProvider: "codex" });
    for (const legacy of [{}, { fallbackProvider: "omp" }, { fallbackProvider: 1 }, null]) {
      expect(await curatorSettings.migrate?.(legacy, 1)).toEqual({});
    }
  });
  it.each([
    { name: "explicit v1 consent", version: 1, values: { fallbackProvider: "codex" }, expected: { fallbackProvider: "codex" } },
    { name: "v1 None default", version: 1, values: {}, expected: {} },
    { name: "unapproved v1 provider", version: 1, values: { fallbackProvider: "omp" }, expected: {} },
    { name: "malformed v1 provider", version: 1, values: { fallbackProvider: 4 }, expected: {} },
    { name: "current pinned provider/model", version: 2, values: { fallbackProvider: "future-harness", fallbackModel: "vendor/nested:model" }, expected: { fallbackProvider: "future-harness", fallbackModel: "vendor/nested:model" } },
  ])("preserves $name after versioned migration, save and disk reopen", async ({ version, values, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "curator-routing-settings-"));
    const file = join(root, "settings.json");
    try {
      // Exercise the definition's versioned storage contract; this is not a live host-store test.
      writeFileSync(file, JSON.stringify({ version, values }));
      const stored = JSON.parse(readFileSync(file, "utf8"));
      const migrated = stored.version === curatorSettings.version
        ? stored.values : await curatorSettings.migrate!(stored.values, stored.version);
      const validated = curatorSettings.schema.parse(migrated);
      writeFileSync(file, JSON.stringify({ version: curatorSettings.version, values: validated }));

      const reopened = JSON.parse(readFileSync(file, "utf8"));
      expect(reopened).toEqual({ version: 2, values: expected });
      expect(curatorSettings.schema.parse(reopened.values)).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("round-trips arbitrary provider IDs and nested models without automatic selection", () => {
    const values = { fallbackProvider: "future-harness", fallbackModel: "vendor/nested:model" };
    expect(curatorSettings.schema.parse(JSON.parse(JSON.stringify(values)))).toEqual(values);
    expect(curatorSettings.schema.parse({})).toEqual({});
    for (const invalid of [{ fallbackProvider: "provider/model" }, { fallbackProvider: 4 }, { fallbackModel: "" }, { fallbackModel: "model" }]) {
      expect(curatorSettings.schema.safeParse(invalid).success).toBe(false);
    }
  });
  it.each(["local.llm", "Acme", "provider_name", "a".repeat(512)])("preserves SDK provider ID %s", fallbackProvider => {
    const values = { fallbackProvider, fallbackModel: "vendor/model" };
    expect(curatorSettings.schema.parse(JSON.parse(JSON.stringify(values)))).toEqual(values);
  });
  it.each(["", " ", "provider name", "provider\tname", "provider\nname", "provider/model", "a".repeat(513)])(
    "rejects malformed or unbounded provider ID %s", fallbackProvider => {
      expect(curatorSettings.schema.safeParse({ fallbackProvider }).success).toBe(false);
    },
  );
  it("keeps object validation strict for custom providers", () => {
    expect(curatorSettings.schema.safeParse({ fallbackProvider: "local.llm", unexpected: true }).success).toBe(false);
    expect(curatorSettings.schema.safeParse({ fallbackModel: "vendor/model" }).success).toBe(false);
  });
});
