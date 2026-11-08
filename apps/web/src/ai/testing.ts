/** Helpers for tests of the AI client. */

/** An SSE body delivered in awkward pieces, like a real network stream. */
export function sseBody(chunks: unknown[], pieceSize = 7): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + pieceSize));
      offset += pieceSize;
    },
  });
}
