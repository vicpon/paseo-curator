import type { ReactNode } from "react";
import type { SettingsActionProps, SettingsRowProps, SettingsSelectProps } from "@getpaseo/plugin/client/ui";

export function SettingsSection({ title, info, children }: { title?: string; info?: string; children: ReactNode }) {
  return <section><h1>{title}</h1><p>{info}</p>{children}</section>;
}
export function SettingsSelect({ label, hint, error, value, options, disabled, onValueChange }: SettingsSelectProps) {
  return <div className="row"><label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><p>{hint}</p>{error && <p role="alert">{error}</p>}</div>;
}
export function SettingsAction({ label, hint, actionLabel, disabled, onPress }: SettingsActionProps) {
  return <div className="row"><div className="line"><strong>{label}</strong><button disabled={disabled} onClick={onPress}>{actionLabel}</button></div>{hint && <p>{hint}</p>}</div>;
}
export function SettingsRow({ label, hint }: SettingsRowProps) {
  return <div className="row"><strong>{label}</strong><p>{hint}</p></div>;
}
