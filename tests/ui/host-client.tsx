import { useState } from "react";
import type { z } from "zod";
import { curatorSettings } from "../../shared/settings";

type Values = z.infer<typeof curatorSettings.schema>;
// Fixture catalog observed with `paseo provider ls --json`, 2026-11-20.
const entries = [
  ["claude", "Claude", true], ["codex", "Codex", true], ["copilot", "Copilot", false],
  ["opencode", "OpenCode", true], ["pi", "Pi", false], ["omp", "Oh My Pi", true],
  ["antigravity", "Antigravity", false], ["muse", "Muse Code", false],
  ["qwen-code", "Qwen Code", false], ["glm-acp-agent", "GLM Agent", true], ["hermes", "Hermes", true],
].map(([provider, label, enabled]) => ({ provider: String(provider), label: String(label), enabled: !!enabled, status: enabled ? "available" : "unavailable" }));
const api = { providers: {
  async waitForReady() { return { entries }; },
  async refresh() {},
  async listModels() { return { models: [{ id: "fixture/default", label: "Fixture default", isDefault: true }, { id: "fixture/pinned", label: "Fixture pinned model" }] }; },
  async listControls(draft: { providerOptions: Record<string, unknown> }) { return { options: draft.providerOptions }; },
} };
export function usePaseo() { return api; }
export function useSettings() {
  const [values, setValues] = useState<Values>(() => JSON.parse(localStorage.getItem("curator-ui-fixture") ?? "{}"));
  const [revision, setRevision] = useState(0);
  return { status: "ready" as const, values, revision: String(revision), saving: false, saveError: null,
    async save(next: Values, expected: string) {
      if (expected !== String(revision)) return;
      const parsed = curatorSettings.schema.parse(next);
      localStorage.setItem("curator-ui-fixture", JSON.stringify(parsed));
      setValues(parsed); setRevision(value => value + 1);
    },
  };
}
