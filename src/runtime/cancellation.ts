/** Give an adapter a bounded opportunity to clean up after its AbortSignal fires. */
export function withCancellation<T>(
  work: Promise<T>,
  signal: AbortSignal,
  cleanupMs = 500,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => {
      timer = setTimeout(
        () => finish(() => reject(signal.reason ?? new Error("Cancelled"))),
        cleanupMs,
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) =>
        finish(() => (signal.aborted ? reject(signal.reason) : resolve(value))),
      (error) => finish(() => reject(error)),
    );
  });
}
