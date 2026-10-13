import type { DeckerAPI } from "./schema";
declare global {
  interface Window {
    decker: DeckerAPI;
  }
  namespace NodeJS {
    interface Process {
      parentPort?: {
        postMessage(message: unknown): void;
        on(
          event: "message",
          listener: (event: { data: unknown }) => void,
        ): void;
      };
    }
  }
}
export {};
