import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { curatorSettings } from "../shared/settings";

export function CuratorSettings() {
  const state = useSettings(curatorSettings);
  if (state.status !== "ready") {
    return (
      <SettingsSection title="Curator routing">
        <SettingsAction label={state.status === "loading" ? "Loading settings" : state.error}
          actionLabel="Reset fallback" disabled={state.status === "loading" || state.saving}
          onPress={() => { void state.reset(); }} />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title="Curator routing"
      info="Fallback sends the bounded source turn and skill index to Codex under its data policy. The turn can contain file contents and secrets. Codex must advertise read-only mode; otherwise the review fails without being sent.">
      <SettingsSelect label="Fallback provider" value={state.values.fallbackProvider ?? ""}
        hint="Used only when the source route is unavailable or lacks a supported read-only policy. None disables cross-provider routing."
        options={[{ label: "None", value: "" }, { label: "Codex (read-only)", value: "codex" }]}
        disabled={state.saving} error={state.saveError}
        onValueChange={(value) => {
          void state.save(value === "codex" ? { fallbackProvider: "codex" } : {}, state.revision);
        }} />
    </SettingsSection>
  );
}
