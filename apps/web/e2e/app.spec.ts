import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MOCK = "http://localhost:8790";
const fixture = (name: string) => fileURLToPath(new URL(`../../../packages/score-core/test/fixtures/${name}`, import.meta.url));

/** Point the app at the mock gateway, as a user would in Settings. */
async function useMockServer(page: Page, serverUrl = MOCK) {
  await page.addInitScript((url) => {
    localStorage.setItem(
      "musicraft.settings.v1",
      JSON.stringify({
        state: { serverUrl: url, apiKey: "test-key", llmPath: "/v1", omrPath: "/omr", modelOverride: "", contextOverride: null, visionOverride: "auto" },
        version: 0,
      }),
    );
  }, serverUrl);
}

async function importFile(page: Page, name: string) {
  await page.goto("./");
  await page.getByTestId("file-input").setInputFiles(fixture(name));
  await expect(page.locator(".score-page svg").first()).toBeVisible();
}

const status = (page: Page) => page.getByTestId("status");

/** A long, fast melody for two flutes (the second resting), to fill many pages quickly. */
function longMelody(bars: number): { name: string; mimeType: string; buffer: Buffer } {
  const steps = ["C", "D", "E", "F", "G", "A", "B", "C"];
  const notes = (bar: number) =>
    [0, 1, 2, 3].map((beat) => `<note><pitch><step>${steps[(bar + beat) % 8]}</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>`).join("");
  const rest = '<note><rest measure="yes"/><duration>4</duration><voice>1</voice></note>';
  const part = (id: string, music: (bar: number) => string) =>
    `<part id="${id}">${Array.from({ length: bars }, (_, i) => `<measure number="${i + 1}">${i === 0 ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>400</per-minute></metronome></direction-type><sound tempo="400"/></direction>' : ""}${music(i)}</measure>`).join("")}</part>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>Long Melody</work-title></work><part-list><score-part id="P1"><part-name>Flute 1</part-name></score-part><score-part id="P2"><part-name>Flute 2</part-name></score-part></part-list>${part("P1", notes)}${part("P2", () => rest)}</score-partwise>`;
  return { name: "long-melody.musicxml", mimeType: "application/xml", buffer: Buffer.from(xml) };
}

test("imports MusicXML, rewrites the part for trumpet in C and exports it", async ({ page }) => {
  await importFile(page, "trumpet-part.musicxml");
  await page.getByRole("button", { name: /Actions for/ }).first().click();
  await page.getByRole("menuitem", { name: "Change instrument…" }).click();
  const instrument = page.getByRole("combobox", { name: "New instrument" });
  await instrument.click();
  await instrument.fill("Trumpet in C");
  await page.getByRole("option", { name: "Trumpet in C" }).click();
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(page.getByTestId("part-card").first()).toContainText("1st C Trumpet");

  await page.getByRole("button", { name: "Export" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "MusicXML (.musicxml)" }).click()]);
  const xml = readFileSync(await download.path(), "utf8");
  expect(xml).toContain("<part-name>1st C Trumpet</part-name>");
  expect(xml).not.toContain("<transpose>");
});

test("enters notes from the keyboard and undoes them", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "New score" }).click();
  await page.getByRole("combobox", { name: "Ensemble" }).click();
  await page.getByRole("option", { name: /Single instrument/ }).click();
  await page.getByRole("combobox", { name: "Instrument" }).click();
  await page.getByRole("combobox", { name: "Instrument" }).fill("Trumpet in B");
  await page.getByRole("option", { name: /Trumpet in B/ }).first().click();
  await page.getByRole("textbox", { name: "Bars" }).fill("4");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".score-page g.mRest").first()).toBeVisible();

  await page.locator(".score-page g.mRest").first().click({ force: true });
  await expect(status(page)).toContainText("whole-bar rest");
  await page.keyboard.press("5");
  await page.keyboard.press("c");
  await page.keyboard.press("d");
  await page.keyboard.press("ArrowLeft");
  await expect(status(page)).toContainText(/bar 1 · D\d \(sounds C\d\) · quarter note/);
  await page.keyboard.press("ArrowUp");
  await expect(status(page)).toContainText(/D#\d|E♭\d|Eb\d/);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".score-page g.note")).toHaveCount(0);
});

test("the assistant rewrites a part and the user keeps the change", async ({ page }) => {
  await useMockServer(page);
  await importFile(page, "trumpet-part.musicxml");
  await page.getByTestId("assistant-toggle").click();
  await expect(page.getByTestId("assistant-panel")).toContainText("mock-vision-model");
  await page.getByTestId("assistant-input").fill("Make this a trumpet in C part");
  await page.keyboard.press("Enter");
  const preview = page.getByTestId("assistant-preview");
  await expect(preview).toContainText("P1 is now Trumpet in C (was Trumpet in Bb, same sound)");
  await expect(page.locator(".measure-mark-green").first()).toBeVisible();
  await expect(status(page)).toContainText("Previewing the assistant's changes");

  // Manual edits wait until the preview is kept or discarded.
  await page.locator(".score-page g.note").first().click({ force: true });
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".mantine-Notification-root").first()).toContainText("Keep or discard the assistant's changes first");

  await page.getByRole("button", { name: "Keep changes" }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByTestId("part-card").first()).toContainText("Trumpet in C");
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText(/^AI: P1 is now Trumpet in C/)).toBeVisible();
});

test("tool errors go back to the model and leave the score alone", async ({ page }) => {
  await useMockServer(page);
  await importFile(page, "trumpet-part.musicxml");
  await page.getByTestId("assistant-toggle").click();
  await page.getByTestId("assistant-input").fill("broken please");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-tool").first()).toContainText("the assistant got an error");
  await expect(page.getByTestId("assistant-panel")).toContainText("Something went wrong");
  await expect(page.getByTestId("assistant-preview")).toHaveCount(0);
});

test("corrects notes by playing them on a MIDI keyboard", async ({ page }) => {
  // A stand-in for a USB keyboard: the test presses its keys.
  await page.addInitScript(() => {
    const input = { name: "Test keyboard", state: "connected", onmidimessage: null as null | ((e: { data: Uint8Array }) => void) };
    const access = { inputs: new Map([["1", input]]), outputs: new Map(), onstatechange: null, sysexEnabled: false };
    Object.defineProperty(navigator, "requestMIDIAccess", { value: async () => access });
    (window as unknown as { playKeys: (keys: number[]) => void }).playKeys = (keys) => keys.forEach((key) => input.onmidimessage?.({ data: new Uint8Array([0x90, key, 100]) }));
  });
  await importFile(page, "trumpet-part.musicxml");
  // Play keys, then wait for them to go in (the selection moves on to the next note).
  const play = async (keys: number[]) => {
    const before = await status(page).textContent();
    await page.evaluate((k) => (window as unknown as { playKeys: (keys: number[]) => void }).playKeys(k), keys);
    await expect(status(page)).not.toHaveText(before ?? "");
  };
  await page.getByTestId("midi").click();
  await expect(page.getByTestId("midi")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("midi").hover();
  await expect(page.getByRole("tooltip")).toContainText("MIDI keyboard connected (Test keyboard)");
  const first = page.locator(".score-page g.note").first();
  const box = (await first.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(status(page)).toContainText("bar 1");
  // Written E5 on the B♭ trumpet (it sounds D5); the next note is selected, to play on.
  await play([76]);
  await page.keyboard.press("ArrowLeft");
  await expect(status(page)).toContainText(/E5 \(sounds D5\)/);
  await page.keyboard.press("ArrowRight");
  // Three keys together: a chord.
  await play([72, 76, 79]);
  await page.keyboard.press("ArrowLeft");
  await expect(status(page)).toContainText(/C5 E5 G5|C5, E5, G5|C5\+E5\+G5/);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(status(page)).not.toContainText(/E5 \(sounds D5\)/);
});

test("reads a photo with the recognition service, then proofreads it against the original", async ({ page, request }) => {
  await useMockServer(page);
  const photo = await (await request.get(`${MOCK}/test-page.png`)).body();
  await page.goto("./");
  await page.getByTestId("file-input").setInputFiles({ name: "page.png", mimeType: "image/png", buffer: photo });
  await expect(page.getByText("Read sheet music")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByText("Trumpet in B♭", { exact: true }).first().click();
  // The server has a second homr: every page is read twice and the better reading kept.
  await expect(page.getByRole("checkbox", { name: /Also read every page with homr 0\.7\.0/ })).toBeChecked();
  await page.getByRole("button", { name: /^Read \d+ page/ }).click();
  await expect(page.getByTestId("scan-readings")).toContainText(
    "page.png: kept the second reading (homr 0.7.0) for every line: 7 of 7 bars with notes add up, against 6 of 7 in the first (mock 1).",
  );
  // The tempo mark the recognition took for the title is dropped; the file name is used instead.
  await expect(page.getByTestId("scan-repairs")).toContainText('"(d=112)" is not a title');
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("page");
  const [raw] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Recognition output" }).click()]);
  expect(readFileSync(await raw.path(), "utf8")).toContain("<work-title>(d=112)</work-title>");
  await page.getByRole("button", { name: "Open score" }).click();
  await expect(page.locator(".score-page svg").first()).toBeVisible();
  await expect(page.getByTestId("original-pages").locator("img").first()).toBeVisible();
  // The reading before the automatic corrections stays in the history.
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("Corrected automatically")).toBeVisible();
  await expect(page.getByText("Recognised from scan, before automatic corrections")).toBeVisible();
  // Nothing corrected by hand yet: every note of the scan is still there.
  await page.getByRole("button", { name: "Compare with the scan" }).click();
  await expect(page.getByTestId("scan-accuracy-report")).toContainText("The scan had 19 of the 19 notes right (100%).");
  await expect(page.getByTestId("scan-accuracy-report")).toContainText("Lines read by homr 0.7.0: 19 of 19 right (100%).");

  // The other engine read bar 3 differently: its version can be put in, and taken out again.
  await page.getByRole("tab", { name: /Checks/ }).click();
  const disagreement = page.getByTestId("disagreement").filter({ hasText: "Bar 3" });
  await expect(disagreement).toContainText("A♭5, or");
  await disagreement.getByRole("button", { name: "Use" }).click();
  await expect(disagreement).toContainText("In use");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(disagreement.getByRole("button", { name: "Use" })).toBeVisible();

  await page.getByRole("button", { name: /Proofread against the original/ }).click();
  await page.getByRole("button", { name: "Start proofreading" }).click();
  await expect(page.getByText(/Checked 1 of 1 lines/)).toBeVisible();
  const finding = page.getByTestId("finding").first();
  await expect(finding).toContainText("octave higher in the original");
  await finding.getByRole("button", { name: "Apply" }).click();
  await expect(finding).toContainText("Applied");
  // The vision model also read a "4" above the last bar's rest: four bars instead of one.
  const rest = page.getByTestId("finding").filter({ hasText: "A 4-bar rest, read as one bar" });
  await rest.getByRole("button", { name: "Apply" }).click();
  await expect(rest).toContainText("Applied");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Transposed score · 11 bars")).toBeVisible();
});

test("adds a part printed on its own to a score, lined up bar by bar, with its page beside it", async ({ page, request }) => {
  await useMockServer(page);
  const photo = await (await request.get(`${MOCK}/test-page.png`)).body();
  await importFile(page, "trumpet-part.musicxml");
  await page.getByTestId("scan-part-input").setInputFiles({ name: "horn part.png", mimeType: "image/png", buffer: photo });
  const wizard = page.getByRole("dialog", { name: "Add a scanned part to Test March" });
  await expect(wizard).toBeVisible();
  await wizard.getByRole("button", { name: "Next" }).click();
  await wizard.getByText("Horn in F", { exact: true }).first().click();
  await wizard.getByRole("checkbox", { name: /Also read every page/ }).uncheck();
  await wizard.getByRole("button", { name: /^Read \d+ page/ }).click();
  const lineup = wizard.getByTestId("part-lineup");
  await expect(lineup).toContainText("How it lines up with Test March");
  await expect(wizard.getByRole("combobox", { name: "Its first bar goes to" })).toHaveValue("Bar 1");
  await wizard.getByRole("button", { name: "Add to the score" }).click();
  await expect(wizard).toBeHidden();
  // Two parts now, and the horn part's page beside the score.
  await expect(page.locator(".score-page g.staff[data-n='2']").first()).toBeVisible();
  await expect(page.getByTestId("original-pages")).toContainText("horn part.png · Horn in F part");
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("Added the Horn in F part from a scan")).toBeVisible();
  // Undo takes the part (and its page) out again.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".score-page g.staff[data-n='2']")).toHaveCount(0);
  await expect(page.getByTestId("original-pages")).not.toContainText("Horn in F part");
});

test("sets multi-bar rests from the list of rests and the bar menu", async ({ page, request }) => {
  await useMockServer(page);
  const photo = await (await request.get(`${MOCK}/test-page.png`)).body();
  await page.goto("./");
  await page.getByTestId("file-input").setInputFiles({ name: "page.png", mimeType: "image/png", buffer: photo });
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByText("Trumpet in B♭", { exact: true }).first().click();
  await page.getByRole("button", { name: /^Read \d+ page/ }).click();
  await page.getByRole("button", { name: "Open score" }).click();
  await expect(page.locator(".score-page svg").first()).toBeVisible();

  // Checks lists the rest bars of a scanned part: bar 8 is printed as a 6-bar rest.
  await page.getByRole("tab", { name: /Checks/ }).click();
  const row = page.getByTestId("rest-run").filter({ hasText: "Bar 8" });
  await row.getByText("Bar 8").click();
  await expect(page.locator(".original-highlight").first()).toBeVisible();
  await row.getByRole("textbox").fill("6");
  await row.getByRole("button", { name: "Set" }).click();
  await expect(page.getByText("Transposed score · 13 bars")).toBeVisible();
  await expect(page.getByTestId("rest-run").filter({ hasText: "Bars 8–13" })).toBeVisible();
  // The line on the original page still covers the new bars.
  await page.getByTestId("rest-run").filter({ hasText: "Bars 8–13" }).getByText("Bars 8–13").click();
  await expect(page.locator(".original-highlight").first()).toBeVisible();

  // The bar menu does the same for the selected bar.
  await page.getByRole("button", { name: "Bar", exact: true }).click();
  await page.getByRole("menuitem", { name: "Multi-bar rest…" }).click();
  await page.getByRole("textbox", { name: "This rest lasts (bars)" }).fill("2");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Transposed score · 9 bars")).toBeVisible();
});

test("arranges a piano piece for brass quintet as a new score", async ({ page }) => {
  await importFile(page, "piano.musicxml");
  await page.getByRole("button", { name: "Arrange for…" }).click();
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await expect(page.locator(".mantine-Modal-body")).toContainText("plays the melody");
  await page.getByRole("button", { name: "Open the arrangement" }).click();
  await expect(page.getByTestId("part-card")).toHaveCount(5);
  await expect(page.getByTestId("part-card").nth(4)).toContainText("Tuba");
});

test("undo while previewing discards the assistant's changes", async ({ page }) => {
  await useMockServer(page);
  await importFile(page, "trumpet-part.musicxml");
  await page.getByTestId("assistant-toggle").click();
  await page.getByTestId("assistant-input").fill("Make this a trumpet in C part");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("assistant-preview")).toBeVisible();
  await page.locator(".score-view").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("assistant-preview")).toHaveCount(0);
  await expect(page.getByTestId("assistant-panel")).toContainText("Changes discarded.");
  await expect(page.getByTestId("part-card").first()).toContainText("Trumpet in B♭");
});

test("ships its Content-Security-Policy", async ({ page }) => {
  const response = await page.goto("./");
  const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(meta).toContain("default-src 'self'");
  // Netlify and Vercel also send it as a header, with protection against framing.
  const header = response?.headers()["content-security-policy"];
  if (header) expect(header).toContain("frame-ancestors 'none'");
});

test("explains when the server doesn't report the model's context size", async ({ page }) => {
  await useMockServer(page, `${MOCK}/noprops`);
  await importFile(page, "trumpet-part.musicxml");
  await page.getByTestId("assistant-toggle").click();
  await expect(page.getByTestId("context-hint")).toContainText("assumes 16,384 tokens");
  // The assistant still works.
  await page.getByTestId("assistant-input").fill("Make this a trumpet in C part");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("assistant-preview")).toBeVisible();
});

/** The middle of a player on screen, from the 3D scene. */
async function playerOnScreen(page: Page, partIndex: number) {
  return page.evaluate((index) => {
    type Object3D = { matrixWorld: unknown };
    const scene = document.querySelector("a-scene") as unknown as { camera: unknown; canvas: HTMLCanvasElement };
    const player = document.querySelectorAll("[data-player]")[index] as unknown as { object3D: Object3D; dataset: DOMStringMap };
    const THREE = (window as unknown as { AFRAME: { THREE: { Vector3: new (x: number, y: number, z: number) => { applyMatrix4(m: unknown): { project(c: unknown): { x: number; y: number } } } } } }).AFRAME.THREE;
    const p = new THREE.Vector3(0, 0.9, 0).applyMatrix4(player.object3D.matrixWorld).project(scene.camera);
    const rect = scene.canvas.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, id: player.dataset.player! };
  }, partIndex);
}

/** Where a player stands on the stage (metres). */
function placeOf(page: Page, partId: string) {
  return page.evaluate((id) => {
    const player = document.querySelector(`[data-player="${id}"]`) as unknown as { object3D: { position: { x: number; z: number } } };
    return `${player.object3D.position.x.toFixed(2)} ${player.object3D.position.z.toFixed(2)}`;
  }, partId);
}

/** A new brass quintet score, shown on the stage. */
async function openQuintetStage(page: Page) {
  await page.goto("./");
  await page.getByRole("button", { name: "New score" }).click();
  await page.getByRole("combobox", { name: "Ensemble" }).click();
  await page.getByRole("option", { name: /Brass quintet \(Bb/ }).click();
  await page.getByRole("textbox", { name: "Bars" }).fill("4");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".score-page svg").first()).toBeVisible();

  await page.getByText("Stage", { exact: true }).click();
  await expect(page.locator("a-scene canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-player]")).toHaveCount(5);
}

test("shows the parts as players on a 3D stage, to select, solo and move", async ({ page }) => {
  await openQuintetStage(page);

  // Selecting a part in the Parts panel selects the player, and the card offers solo, mute and volume.
  await page.getByTestId("part-card").filter({ hasText: "Tuba" }).click();
  const card = page.getByTestId("player-card");
  await expect(card).toContainText("Tuba");
  await card.getByRole("button", { name: "Solo" }).click();
  await expect(page.getByRole("button", { name: "Mute parts" })).toHaveAttribute("data-variant", "light");

  // Pointing at a player in 3D selects it.
  await page.waitForTimeout(1500); // the camera settles
  const trumpet = await playerOnScreen(page, 0);
  await page.mouse.move(trumpet.x, trumpet.y);
  await page.waitForTimeout(300);
  await page.mouse.click(trumpet.x, trumpet.y);
  await expect(card).toContainText("Trumpet 1");

  // In move mode a player can be dragged somewhere else; the place is kept.
  await page.getByTestId("move-players").click();
  const tuba = await playerOnScreen(page, 4);
  const before = await placeOf(page, tuba.id);
  await page.mouse.move(tuba.x, tuba.y);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.mouse.move(tuba.x - 150, tuba.y - 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => placeOf(page, tuba.id)).not.toEqual(before);

  // The bandstand, and back to the score with the part still selected.
  await page.getByText("Bandstand", { exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (document.querySelector("[mc-venue]") as unknown as { components: Record<string, { data: { type: string } }> }).components["mc-venue"]!.data.type))
    .toBe("bandstand");
  await card.getByRole("button", { name: "Show in score" }).click();
  await expect(page.locator(".score-page svg").first()).toBeVisible();
  await expect(page.getByTestId("part-card").filter({ hasText: "Trumpet 1" })).toHaveAttribute("data-selected", "true");
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("moves a player on the stage with a finger, without turning the camera", async ({ page }) => {
    await openQuintetStage(page);
    await page.getByTestId("move-players").click();
    await page.waitForTimeout(1500); // the camera settles
    const yaw = () =>
      page.evaluate(() => {
        const camera = document.querySelector("[look-controls]") as unknown as { components: Record<string, { yawObject: { rotation: { y: number } } }> };
        return camera.components["look-controls"]!.yawObject.rotation.y.toFixed(3);
      });
    const turned = await yaw();
    const tuba = await playerOnScreen(page, 4);
    const before = await placeOf(page, tuba.id);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await touch("touchStart", tuba.x, tuba.y);
    for (let step = 1; step <= 6; step++) await touch("touchMove", tuba.x - 25 * step, tuba.y - 7 * step);
    await touch("touchEnd");
    await expect.poll(() => placeOf(page, tuba.id)).not.toEqual(before);
    expect(await yaw()).toBe(turned);
  });
});

test("practises with a count-in, a metronome and a loop that gets faster each time round", async ({ page }) => {
  await importFile(page, "trumpet-part.musicxml");
  await page.getByTestId("practice").click();
  for (const name of ["Metronome", "Count in", "Speed trainer"]) await page.getByRole("switch", { name }).check({ force: true });
  // The speed trainer loops: bar 2 alone, from 70% and 5% faster each time.
  await expect(page.getByRole("switch", { name: /^Loop/ })).toBeChecked();
  await page.keyboard.press("Escape");
  const notes = page.locator(".score-page g.note");
  const box = (await notes.nth(3).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByTestId("play").click();
  await page.getByTestId("practice").click();
  await expect(page.getByTestId("practice-pass")).toContainText("Round 1, at 70%");
  await expect(page.getByTestId("practice-pass")).toContainText("Round 2, at 75%", { timeout: 20_000 });
  await expect(page.locator("input[aria-label=Tempo]")).toHaveValue("75%");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Stop" }).click();
});

test("plays from the music full screen, turning pages by key, by tap and by itself", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("./");
  await page.getByTestId("file-input").setInputFiles(longMelody(64));
  await expect(page.locator(".score-page svg").first()).toBeVisible();
  await page.getByRole("button", { name: "Performance mode" }).click();
  // The editor underneath is inert; its controls stay out of reach.
  const perform = page.getByTestId("perform-view");
  await expect(page.locator(".mantine-AppShell-root")).toHaveAttribute("inert", "");
  const label = page.getByTestId("perform-page-label");
  await expect(label).toHaveText(/^Page 1 of (\d+)$/);
  const pages = Number((await label.textContent())!.match(/of (\d+)/)![1]);
  expect(pages).toBeGreaterThanOrEqual(3);
  // Half-page turns: first the top of page 2 above the end of page 1, then page 2.
  await page.keyboard.press("ArrowRight");
  await expect(label).toHaveText(`Pages 1–2 of ${pages}`);
  await expect(page.locator(".perform-cut")).toBeVisible();
  await page.keyboard.press("PageDown");
  await expect(label).toHaveText(`Page 2 of ${pages}`);
  // A tap on the left goes back; whole pages without half turns.
  await page.mouse.click(100, 600);
  await expect(label).toHaveText(`Pages 1–2 of ${pages}`);
  // The controls come back with the mouse (or a tap at the top).
  await page.mouse.move(400, 300);
  await expect(page.locator(".perform-chrome-shown")).toBeVisible();
  await perform.getByRole("switch", { name: "Half-page turns" }).uncheck({ force: true });
  await page.keyboard.press("ArrowRight");
  await expect(label).toHaveText(/^Page \d of/);
  // Played along with, the pages follow the music: from the last page, Home and the next bar bring it back.
  await page.keyboard.press("End");
  await expect(label).toHaveText(`Page ${pages} of ${pages}`);
  await page.mouse.move(400, 320);
  await perform.getByRole("button", { name: "Play" }).click();
  await page.keyboard.press("Home");
  await expect(label).toHaveText(`Page ${pages} of ${pages}`, { timeout: 5000 });
  await perform.getByRole("button", { name: "Back to the beginning" }).click();
  await expect(label).toHaveText(`Page 1 of ${pages}`);
  // One part, as its player reads it: Flute 2 rests throughout, one multi-bar rest on one page.
  await perform.getByRole("combobox", { name: "What to show" }).click();
  await page.getByRole("option", { name: "Flute 2" }).click();
  await expect(label).toHaveText("Page 1 of 1");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("perform-view")).toBeHidden();
  await expect(page.locator(".score-page svg").first()).toBeVisible();
});

test("exports the music as an audio file", async ({ page }) => {
  const recordings: string[] = [];
  page.on("request", (r) => {
    if (/\/samples\/trumpet\/\d+[pf]?\.mp3$/.test(r.url())) recordings.push(r.url());
  });
  await importFile(page, "trumpet-part.musicxml");
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: /Audio or play-along/ }).click();
  await page.getByRole("switch", { name: "Count in" }).check({ force: true });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download WAV" }).click()]);
  expect(download.suggestedFilename()).toBe("Test March.wav");
  const wav = readFileSync(await download.path());
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  const channels = wav.readUInt16LE(22);
  const seconds = wav.readUInt32LE(40) / (channels * 2 * wav.readUInt32LE(24));
  // A bar of count-in, 19 seconds of music and the hall's echo.
  expect(seconds).toBeGreaterThan(21);
  expect(seconds).toBeLessThan(26);
  let loudest = 0;
  for (let i = 44; i < wav.length; i += 2) loudest = Math.max(loudest, Math.abs(wav.readInt16LE(i)));
  expect(loudest).toBeGreaterThan(3000);
  // With the trumpet's real recordings: only the loud ones (the march is marked f), and only those
  // near the notes it plays.
  expect(recordings.length).toBeGreaterThan(0);
  expect(recordings.every((url) => url.endsWith("f.mp3"))).toBe(true);
  expect(new Set(recordings).size).toBeLessThan(8);
});

test("explains every control in a tooltip, also when it can't be used yet", async ({ page }) => {
  await importFile(page, "trumpet-part.musicxml");
  await page.getByRole("button", { name: "Zoom in" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Zoom in: larger notation");
  await page.getByRole("button", { name: "Dot (.)" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Select a note or rest first.");
  // Screen readers hear that it can't be used yet.
  await expect(page.getByRole("button", { name: "Dot (.)" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: "Zoom in" })).not.toHaveAttribute("aria-disabled");
});
