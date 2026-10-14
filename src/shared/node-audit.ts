import type { FlowNode } from "./schema";
export const nodeAuditHints: Record<FlowNode["kind"], string> = {
  trigger:
    "Returns declared workflow inputs. A trigger is an entry point, not a schedule.",
  action:
    "Resolved field types are checked before effects. Only successful known output fields are guaranteed; use fallback on conditional/error paths.",
  delay:
    "ms resolves to a duration from 0–3600000. Waiting observes timeout and cancellation.",
  condition:
    "left/right keep native JSON types. true/false/error ports retain existing condition semantics.",
  switch:
    "value selects an existing named port or default. Edit cases in Configuration JSON; switch semantics are unchanged.",
  set: "Configuration keys name variables. Values retain JSON types; changes in branches/loop bodies stay in those scopes.",
  parallel:
    "Each branch inherits outer data and uses its own scope. Results join by branch index; sibling outputs are unavailable.",
  repeat:
    "Bounded loop within one execution, not a clock or schedule trigger. count is 0–maxIterations; item/index exist only in its body.",
  foreach:
    "items must resolve to an array. Bounded iterations and concurrency 1–16; item/index exist only in its body.",
  subflow:
    "Pin the selected revision and map declared inputs. Subflow inputs, variables and outputs have a fresh scope.",
  return:
    "Returns Configuration as native JSON. Keys must match declared workflow outputs; no output ports.",
};
