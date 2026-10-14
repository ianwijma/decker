import { z } from "zod";

// Desktop requests contain transient input, never a renderer-selected secret ref.
export const obsUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        !["ws:", "wss:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.hash ||
        url.hostname.length > 253 ||
        (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Use a ws:// or wss:// address without embedded credentials.",
      });
    }
  });
const owner = z.string().min(1).max(1000);
const epoch = z.string().min(1).max(100);
const password = z.string().min(1).max(16000);
export const obsTestRequestSchema = z
  .object({
    type: z.literal("obsTest"),
    id: z.string().uuid(),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("draft"), url: obsUrlSchema }).strict(),
      z
        .object({ kind: z.literal("saved"), owner, epoch, url: obsUrlSchema })
        .strict(),
    ]),
    credential: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("supplied"), password }).strict(),
      z.object({ kind: z.literal("stored") }).strict(),
      z.object({ kind: z.literal("none") }).strict(),
    ]),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.target.kind === "draft" && request.credential.kind === "stored")
      ctx.addIssue({
        code: "custom",
        message: "A draft has no stored password.",
      });
  });
export const obsCancelRequestSchema = z
  .object({ type: z.literal("obsCancel"), id: z.string().uuid() })
  .strict();
export const obsSaveRequestSchema = z
  .object({
    type: z.literal("obsSave"),
    epoch,
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("new") }).strict(),
      z.object({ kind: z.literal("saved"), owner }).strict(),
    ]),
    name: z.string().trim().min(1).max(100),
    url: obsUrlSchema,
    credential: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("replace"), password, persist: z.boolean() })
        .strict(),
      z.object({ kind: z.literal("keep") }).strict(),
      z.object({ kind: z.literal("none") }).strict(),
    ]),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.target.kind === "new" && request.credential.kind === "keep")
      ctx.addIssue({
        code: "custom",
        message:
          "Enter a password for this draft or explicitly choose no authentication.",
      });
  });
export type ObsTestRequest = z.infer<typeof obsTestRequestSchema>;
export type ObsSaveRequest = z.infer<typeof obsSaveRequestSchema>;
export type ObsTestStatus =
  | "success"
  | "unreachable"
  | "timeout"
  | "authentication"
  | "missing-credential"
  | "locked-credential"
  | "incompatible"
  | "invalid-input"
  | "cancelled"
  | "busy"
  | "error";
export type ObsTestResult = {
  id: string;
  status: ObsTestStatus;
  message: string;
};

export const obsHelpRequestSchema = z
  .object({ type: z.literal("obsHelp") })
  .strict();
