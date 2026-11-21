import { liveSnapshot, routingSnapshot, routingModels, routingControls } from "../routing-fixtures";
import { useState } from "react";
import type { z } from "zod";
import { curatorSettings } from "../../shared/settings";

type Values = z.infer<typeof curatorSettings.schema>;
const entries = liveSnapshot.entries;
const api = { providers: {
  async waitForReady() { return routingSnapshot(entries); },
  async refresh() {},
  async listModels(provider: string) { return routingModels(provider, [{ id: "fixture/default", label: "Fixture default", isDefault: true }, { id: "fixture/pinned", label: "Fixture pinned model" }]); },
  listControls: routingControls,
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
