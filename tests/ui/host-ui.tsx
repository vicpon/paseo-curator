import type { ReactNode } from "react";
import type { SettingsActionProps, SettingsRowProps, SettingsSelectProps } from "@getpaseo/plugin/client/ui";
import type { PressableProps, TextProps } from "react-native";

export function SettingsSection({ title, info, trailing, children }: { title?: string; info?: string; trailing?: ReactNode; children: ReactNode }) {
  return <section><div className="line"><h1>{title}</h1>{trailing}</div><p>{info}</p>{children}</section>;
}
export function Pressable({ children, onPress, disabled, accessibilityLabel }: PressableProps) {
  return <button type="button" aria-label={accessibilityLabel} disabled={disabled ?? false} onClick={() => onPress?.({} as never)}>{typeof children === "function" ? children({ pressed: false }) : children}</button>;
}
export function Text({ children }: TextProps) {
  return <span>{children}</span>;
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
