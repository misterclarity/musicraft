/** The chat history the assistant keeps between requests. */
import type { ChatMessage } from "./llm";

/** The short form of a finished request kept for later turns: the request and the answer. */
export function compactTurn(request: string, answer: string, changes: string[]): ChatMessage[] {
  const done = changes.length ? `\n(Changes made: ${changes.join("; ")})` : "";
  return [
    { role: "user", content: request },
    { role: "assistant", content: `${answer}${done}`.trim() || "(no answer)" },
  ];
}
