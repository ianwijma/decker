import type { KeyBinding } from "./schema";

/** Preserve v4's on/off/source JSON order and durable stamp; artwork is cosmetic. */
export function executableToggle(binding: KeyBinding) {
  const t = binding.toggle;
  return t ? { on: t.on, off: t.off, source: t.source } : undefined;
}
export function bindingExecutionIdentity(binding: KeyBinding) {
  if (!binding.toggle) return { ...binding, generation: 0 };
  const { appearance: _, ...rest } = binding;
  return { ...rest, generation: 0, toggle: executableToggle(binding) };
}
