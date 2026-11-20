import type { PaseoProviderActions } from "@getpaseo/client";

/** Provider discovery is host-owned; only native confinement policies belong here. */
export type RoutingProviders = Pick<PaseoProviderActions, "waitForReady" | "listModels">
  & Partial<Pick<PaseoProviderActions, "listControls">>;

export interface ReadOnlyConfig {
  provider: string;
  options: Record<string, unknown>;
  toolPolicy: { preapproved: [] };
}

// Verified against Paseo 0.16.2's shipped provider implementations; see docs/routing.md.
// These are provider-native controls, deliberately independent of session mode IDs.
function nativeOptions(provider: string): Record<string, unknown> | null {
  switch (provider) {
    case "codex": return { sandbox_mode: "read-only", approval_policy: "never" };
    case "claude": return {
      extraArgs: { tools: "Read,Glob,Grep" },
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["mcp__*"],
    };
    default: return null;
  }
}

export function confinementStatus(provider: string): string | null {
  switch (provider) {
    case "codex": case "claude": return null;
    case "omp": return "Paseo exposes approval modes, but no native read-only sandbox or tool allowlist for OMP.";
    case "opencode": return "Paseo exposes deny-all or fixed permission keys, but no verified read-only allowlist covering extension tools.";
    default: return "This host provider has no verified native read-only sandbox or tool allowlist exposed to Curator.";
  }
}

export interface RoutingProvider {
  id: string;
  label: string;
  supported: boolean;
  reason: string;
  models: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>;
}

export async function discoverRoutingProviders(api: RoutingProviders): Promise<RoutingProvider[]> {
  const { entries } = await api.waitForReady({ timeoutMs: 10_000 });
  return Promise.all([...entries].sort((a, b) => a.provider.localeCompare(b.provider)).map(async entry => {
    const reason = !entry.enabled ? "Disabled in host settings."
      : entry.status !== "ready" ? "Unavailable on this host."
      : confinementStatus(entry.provider);
    if (reason) return { id: entry.provider, label: entry.label ?? entry.provider, supported: false, reason, models: [] };
    try {
      const { models, error } = await api.listModels(entry.provider);
      const model = models?.find(m => m.isDefault) ?? models?.[0];
      const config = model && !error ? await resolveReadOnlyConfig(api, `${entry.provider}/${model.id}`, ".") : null;
      return {
        id: entry.provider, label: entry.label ?? entry.provider, supported: config !== null,
        reason: config ? (entry.provider === "claude" ? "Read, Glob and Grep only; MCP tools denied." : "Native read-only sandbox; escalation disabled.")
          : "Host could not resolve the required native controls or an available model.",
        models: models ?? [],
      };
    } catch {
      return { id: entry.provider, label: entry.label ?? entry.provider, supported: false, reason: "Provider discovery failed; refresh to retry.", models: [] };
    }
  }));
}

function contains(actual: unknown, required: unknown): boolean {
  if (Array.isArray(required)) return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(required);
  if (required !== null && typeof required === "object") {
    return actual !== null && typeof actual === "object" && Object.entries(required).every(
      ([key, value]) => contains((actual as Record<string, unknown>)[key], value),
    );
  }
  return actual === required;
}

export async function resolveReadOnlyConfig(api: RoutingProviders, selection: string, cwd: string): Promise<ReadOnlyConfig | null> {
  const options = nativeOptions(selection.split("/")[0]);
  if (!options || !api.listControls) return null;
  try {
    const effective = await api.listControls({ provider: selection, cwd, providerOptions: options });
    if (effective.error || !contains(effective.options, options)) return null;
    return { provider: selection, options, toolPolicy: { preapproved: [] } };
  } catch { return null; }
}
