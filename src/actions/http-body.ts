export const HTTP_BODY_LIMIT = 16384;
/** Retain at most the byte limit; a further nonempty chunk proves truncation. */
export async function readHttpBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0,
    body = "",
    truncated = false;
  try {
    while (reader) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      const remaining = HTTP_BODY_LIMIT - bytes;
      const kept = value.subarray(0, remaining);
      body += decoder.decode(kept, { stream: true });
      bytes += kept.length;
      if (value.length > remaining) {
        truncated = true;
        break;
      }
      // At the exact limit read again to distinguish EOF from another chunk.
    }
    // Omit an incomplete trailing codepoint when truncated, rather than emit U+FFFD.
    if (!truncated) body += decoder.decode();
    return { body, truncated };
  } finally {
    try {
      await reader?.cancel();
    } finally {
      reader?.releaseLock();
    }
  }
}
