import type { KeyBinding, Target } from "./schema";

/** One traversal for runtime validation, profile copying and credential owners. */
export function bindingTargets(binding: KeyBinding) {
  const entries: { phase: string; target: Target }[] = [];
  for (const phase of ["press", "release", "longPress"] as const) {
    const target = binding[phase];
    if (target) entries.push({ phase, target });
  }
  if (binding.toggle) {
    entries.push({ phase: "toggle.on", target: binding.toggle.on });
    entries.push({ phase: "toggle.off", target: binding.toggle.off });
    if (binding.toggle.source.kind === "external")
      entries.push({
        phase: "toggle.probe",
        target: binding.toggle.source.probe,
      });
  }
  return entries;
}
