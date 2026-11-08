import { describe, expect, it, vi } from "vitest";
import { Renderer, SupersededError } from "./renderer";

/** A stand-in for the Verovio worker that answers when the test says so. */
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: { id: number; xml: string }[] = [];
  postMessage(message: { id: number; xml: string }) {
    this.posted.push(message);
  }
  reply(index: number, svgs: string[]) {
    this.onmessage?.({ data: { id: this.posted[index]!.id, svgs } } as MessageEvent);
  }
}

describe("screen rendering", () => {
  it("only engraves the newest score when edits arrive faster than renders", async () => {
    const worker = new FakeWorker();
    const renderer = new Renderer(() => worker as unknown as Worker);
    const first = renderer.renderLatest("screen", "v1", {});
    const second = renderer.renderLatest("screen", "v2", {});
    const third = renderer.renderLatest("screen", "v3", {});
    // v1 is being engraved; v2 was replaced by v3 before it started.
    expect(worker.posted.map((m) => m.xml)).toEqual(["v1"]);
    await expect(second).rejects.toBeInstanceOf(SupersededError);
    worker.reply(0, ["<svg>v1</svg>"]);
    await expect(first).resolves.toEqual(["<svg>v1</svg>"]);
    await vi.waitFor(() => expect(worker.posted.map((m) => m.xml)).toEqual(["v1", "v3"]));
    worker.reply(1, ["<svg>v3</svg>"]);
    await expect(third).resolves.toEqual(["<svg>v3</svg>"]);
  });

  it("keeps other renders (exports) out of the queue", async () => {
    const worker = new FakeWorker();
    const renderer = new Renderer(() => worker as unknown as Worker);
    void renderer.renderLatest("screen", "screen", {});
    const exported = renderer.render("export", {});
    expect(worker.posted.map((m) => m.xml)).toEqual(["screen", "export"]);
    worker.reply(1, ["page"]);
    await expect(exported).resolves.toEqual(["page"]);
  });
});
