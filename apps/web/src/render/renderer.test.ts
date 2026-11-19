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
  replyAhead(index: number, page: number, svg: string, count: number) {
    this.onmessage?.({ data: { id: this.posted[index]!.id, ahead: { index: page, svg, count } } } as MessageEvent);
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

  it("hands over the page on screen before the rest of the score", async () => {
    const worker = new FakeWorker();
    const renderer = new Renderer(() => worker as unknown as Worker);
    const pages: unknown[] = [];
    const done = renderer.renderLatest("screen", "v1", {}, { first: 2, onPage: (page) => pages.push(page) });
    expect(worker.posted[0]).toMatchObject({ xml: "v1", first: 2 });
    worker.replyAhead(0, 2, "<svg>3</svg>", 4);
    expect(pages).toEqual([{ index: 2, svg: "<svg>3</svg>", count: 4 }]);
    worker.reply(0, ["1", "2", "<svg>3</svg>", "4"]);
    await expect(done).resolves.toHaveLength(4);
    expect(pages).toHaveLength(1);
  });

  it("starts the engraver when the browser is idle, once", async () => {
    let created = 0;
    const renderer = new Renderer(() => {
      created++;
      return new FakeWorker() as unknown as Worker;
    });
    renderer.warmUp();
    renderer.warmUp();
    await vi.waitFor(() => expect(created).toBe(1), { timeout: 5000 });
    void renderer.renderLatest("screen", "v1", {});
    expect(created).toBe(1);
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
