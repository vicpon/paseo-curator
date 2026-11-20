import { useEffect, useState } from "react";
import { Button } from "react-native";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { curatorSettings } from "../shared/settings";
import { discoverRoutingProviders, type RoutingProvider } from "../shared/routing";

export function CuratorSettings() {
  const state = useSettings(curatorSettings);
  const paseo = usePaseo();
  const [catalog, setCatalog] = useState<RoutingProvider[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setCatalog([]);
    void (async () => {
      if (refresh > 0) await paseo.providers.refresh();
      const next = await discoverRoutingProviders(paseo.providers);
      if (!disposed) {
        // Reasons are fixed discovery messages; never log host labels, models or raw errors.
        for (const item of next.filter(p => !p.supported)) {
          console.info("[curator] Provider omitted from review choices:", item.reason);
        }
        setCatalog(next.filter(p => p.supported));
      }
    })().catch(() => {
      if (!disposed) {
        console.info("[curator] Provider discovery failed; refresh to retry.");
        setError("Provider discovery failed. Refresh to retry; your selection is preserved.");
      }
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [paseo, refresh]);

  if (state.status !== "ready") {
    return (
      <SettingsSection title="Curator routing">
        <SettingsAction label={state.status === "loading" ? "Loading settings" : state.error}
          actionLabel="Reset review settings" disabled={state.status === "loading" || state.saving}
          onPress={() => { void state.reset(); }} />
      </SettingsSection>
    );
  }
  const selected = state.values.fallbackProvider;
  const provider = catalog.find(p => p.id === selected);
  const options = catalog.filter(p => p.supported).map(p => ({ label: p.label, value: p.id }));
  const inactive = !!selected && !options.some(p => p.value === selected);
  // Paseo displays an unmatched value as the trigger caption, without adding a menu choice.
  const providerValue = inactive ? (loading ? "Saved review provider (checking host)" : "Saved review provider inactive") : selected ?? "";
  const models = provider?.models.map(model => ({ label: model.label, value: model.id })) ?? [];
  const selectedModel = state.values.fallbackModel;
  if (selectedModel && !models.some(m => m.value === selectedModel)) {
    models.push({ label: `${selectedModel} (unavailable; selection preserved)`, value: selectedModel });
  }
  return (
    <SettingsSection title="Curator routing"
      info="Reviews use the source provider and model when safe. The selected provider is used when the source review cannot run. It receives a bounded source turn and skill index under its data policy; tool-less reviews also receive captured skill text. This data can contain file contents and secrets. Read-only tools can read workspace and skill files."
      trailing={<Button title="Refresh providers" disabled={loading} onPress={() => setRefresh(value => value + 1)} />}>
      <SettingsSelect label="Review provider" value={providerValue}
        hint="Choose a provider to allow these reviews; None revokes that permission."
        options={[{ label: "None", value: "" }, ...options]}
        disabled={state.saving} error={state.saveError}
        onValueChange={value => {
          if (value === "") void state.save({}, state.revision);
          else if (!loading && !error && catalog.some(p => p.id === value && p.supported)) {
            void state.save({ fallbackProvider: value }, state.revision);
          }
        }} />
      {inactive && !loading && <SettingsRow label="Saved review provider is inactive. Choose a provider or None; your saved choice is preserved." />}
      {selected && provider && <SettingsSelect label="Review model" value={selectedModel ?? ""}
        hint="Use the provider default or pin a model. Refresh preserves your choice; unavailable models cannot run."
        options={[{ label: "Provider default", value: "" }, ...models]}
        disabled={state.saving || loading || !!error || !provider?.supported}
        onValueChange={value => {
          if (value === "" || provider?.models.some(model => model.id === value)) {
            void state.save({ fallbackProvider: selected, ...(value ? { fallbackModel: value } : {}) }, state.revision);
          }
        }} />}
      {error && <SettingsRow label={error} />}
    </SettingsSection>
  );
}
