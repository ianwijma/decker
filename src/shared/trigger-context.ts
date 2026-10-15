import { z } from "zod";
import type { AppDocument, KeyBinding } from "./schema";

const id = z.string().min(1).max(160);
export const buttonOriginSchema = z
  .object({
    deckId: id,
    profileId: id,
    pageId: id,
    bindingId: id,
    generation: z.number().int().nonnegative(),
  })
  .strict();
export type ButtonOrigin = z.infer<typeof buttonOriginSchema>;
export const launchSourceSchema = z
  .object({
    kind: z.enum(["button", "test", "manual", "scheduled", "refresh", "probe"]),
    invocationId: id,
    origin: buttonOriginSchema.optional(),
  })
  .strict();
/** Trusted main/runtime API. Never decode this from renderer requests or action config. */
export type LaunchSource = z.infer<typeof launchSourceSchema>;
export type TrustedLaunch = { source: LaunchSource; authority?: string };
export const executionContextSchema = z
  .object({
    source: z.object({ kind: launchSourceSchema.shape.kind }).strict(),
    origin: buttonOriginSchema.nullable(),
    rootRunId: id,
    invocationId: id,
    rootWorkflowId: id,
    workflowId: id,
    workflowInvocationId: id,
  })
  .strict();
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export const originKey = (origin: ButtonOrigin) =>
  JSON.stringify([
    origin.deckId,
    origin.profileId,
    origin.pageId,
    origin.bindingId,
    origin.generation,
  ]);
export function originBinding(
  document: AppDocument,
  origin: ButtonOrigin,
): KeyBinding | undefined {
  const deck = document.decks.find((d) => d.id === origin.deckId);
  if (!deck?.profileIds.includes(origin.profileId)) return;
  return Object.values(
    document.profiles
      .find((p) => p.id === origin.profileId)
      ?.pages.find((p) => p.id === origin.pageId)?.keys ?? {},
  ).find(
    (b) => b.id === origin.bindingId && b.generation === origin.generation,
  );
}
/** Capture an exact saved identity anywhere in its owning deck, independent of selection. */
export function captureOrigin(
  document: AppDocument,
  deckId: string,
  binding: Pick<KeyBinding, "id" | "generation">,
): ButtonOrigin | undefined {
  const deck = document.decks.find((d) => d.id === deckId);
  for (const profile of document.profiles.filter((p) =>
    deck?.profileIds.includes(p.id),
  ))
    for (const page of profile.pages)
      if (
        Object.values(page.keys).some(
          (b) => b.id === binding.id && b.generation === binding.generation,
        )
      )
        return {
          deckId,
          profileId: profile.id,
          pageId: page.id,
          bindingId: binding.id,
          generation: binding.generation,
        };
}
