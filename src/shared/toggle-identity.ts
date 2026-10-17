import type { KeyBinding } from "./schema";

/** Preserve v4's on/off/source JSON order and durable stamp; artwork is cosmetic. */
export function executableToggle(binding: KeyBinding) {
  const t = binding.toggle;
  return t ? { on: t.on, off: t.off, source: t.source } : undefined;
}
export function bindingExecutionIdentity(binding: KeyBinding) {
  const { refresh: _refresh, ...ordinary } = binding;
  if (!binding.toggle) return { ...ordinary, generation: 0 };
  const { appearance: _, ...rest } = ordinary;
  return { ...rest, generation: 0, toggle: executableToggle(binding) };
}
