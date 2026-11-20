import { useEffect, useState } from "react";
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
    void (async () => {
      if (refresh > 0) await paseo.providers.refresh();
      const next = await discoverRoutingProviders(paseo.providers);
      if (!disposed) setCatalog(next);
    })().catch(() => {
      if (!disposed) setError("Provider discovery failed. Refresh to retry; your selection is preserved.");
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [paseo, refresh]);

  if (state.status !== "ready") {
    return (
      <SettingsSection title="Curator routing">
        <SettingsAction label={state.status === "loading" ? "Loading settings" : state.error}
          actionLabel="Reset fallback" disabled={state.status === "loading" || state.saving}
          onPress={() => { void state.reset(); }} />
      </SettingsSection>
    );
  }
  const selected = state.values.fallbackProvider;
  const provider = catalog.find(p => p.id === selected);
  const options = catalog.filter(p => p.supported).map(p => ({ label: p.label, value: p.id }));
  if (selected && !options.some(p => p.value === selected)) {
    options.push({ label: `${provider?.label ?? selected} (unavailable; selection preserved)`, value: selected });
  }
  const models = provider?.models.map(model => ({ label: model.label, value: model.id })) ?? [];
  const selectedModel = state.values.fallbackModel;
  if (selectedModel && !models.some(m => m.value === selectedModel)) {
    models.push({ label: `${selectedModel} (unavailable; selection preserved)`, value: selectedModel });
  }
  return (
    <SettingsSection title="Curator routing"
      info="Fallback sends the bounded source turn and skill index to your selected provider under its data policy. The turn can contain file contents and secrets. Read-only tools can read workspace and skill files. None disables cross-provider transmission; source reviews use the exact source provider and model when safe.">
      <SettingsSelect label="Fallback provider" value={selected ?? ""}
        hint="Only your explicit choice enables fallback. Unavailable providers remain listed below. None revokes fallback, including during refresh."
        options={[{ label: "None", value: "" }, ...options]}
        disabled={state.saving} error={state.saveError}
        onValueChange={value => {
          if (value === "") void state.save({}, state.revision);
          else if (!loading && !error && catalog.some(p => p.id === value && p.supported)) {
            void state.save({ fallbackProvider: value }, state.revision);
          }
        }} />
      {selected && <SettingsSelect label="Fallback model" value={selectedModel ?? ""}
        hint="Provider default follows that provider's current default model. An explicit model is preserved on refresh; unavailable selections fail closed. Changing this model changes where review data is sent."
        options={[{ label: "Provider default", value: "" }, ...models]}
        disabled={state.saving || loading || !!error || !provider?.supported}
        onValueChange={value => {
          if (value === "" || provider?.models.some(model => model.id === value)) {
            void state.save({ fallbackProvider: selected, ...(value ? { fallbackModel: value } : {}) }, state.revision);
          }
        }} />}
      <SettingsAction label={loading ? "Loading providers" : error ?? "Provider availability and safety"}
        actionLabel="Refresh providers" disabled={loading} onPress={() => setRefresh(value => value + 1)} />
      {catalog.map(item => item.supported
        ? <SettingsRow key={item.id} label={item.label} hint={item.reason} />
        : <SettingsAction key={item.id} label={item.label} hint={item.reason}
            actionLabel="Unavailable" disabled onPress={() => {}} />)}
    </SettingsSection>
  );
}
