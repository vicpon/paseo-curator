import type { PaseoProviderActions } from "@getpaseo/client";

/** Eligibility comes from the host's enabled/ready catalog, not provider families. */
export type RoutingProviders = Pick<PaseoProviderActions, "waitForReady" | "listModels">
  & Partial<Pick<PaseoProviderActions, "listControls">>;

/** Omitted options and mode leave normal configuration resolution to the provider. */
export interface ReviewConfig {
  provider: string;
}

export interface RoutingProvider {
  id: string;
  label: string;
  available: boolean;
  supported: boolean;
  reason: string;
  models: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>;
}

export async function discoverRoutingProviders(api: RoutingProviders): Promise<RoutingProvider[]> {
  const { entries } = await api.waitForReady({ timeoutMs: 10_000 });
  return Promise.all(entries.filter(entry => entry.enabled).sort((a, b) => a.provider.localeCompare(b.provider)).map(async entry => {
    const available = entry.status === "ready";
    if (!available) return { id: entry.provider, label: entry.label ?? entry.provider, available, supported: false, reason: "Unavailable on this host.", models: [] };
    // Model enumeration can fail independently of host readiness.
    let models: RoutingProvider["models"] = [];
    try {
      const result = await api.listModels(entry.provider);
      if (!result.error) models = result.models ?? [];
    } catch { /* Keep ready providers selectable; retry model discovery at creation. */ }
    return { id: entry.provider, label: entry.label ?? entry.provider, available, supported: true, reason: "", models };
  }));
}
