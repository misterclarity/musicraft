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
  await expect(page.getByTestId("scan-readings")).toContainText("page.png: kept the second reading (homr 0.7.0): 7 of 7 bars with notes add up, against 6 of 7 in the first (mock 1).");
  // The tempo mark the recognition took for the title is dropped; the file name is used instead.
  await expect(page.getByTestId("scan-repairs")).toContainText('"(d=112)" is not a title');
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("page");
  const [raw] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Recognition output" }).click()]);
  expect(readFileSync(await raw.path(), "utf8")).toContain("<work-title>(d=112)</work-title>");
  await page.getByRole("button", { name: "Open score" }).click();
  await expect(page.locator(".score-page svg").first()).toBeVisible();
  await expect(page.getByTestId("original-pages").locator("img").first()).toBeVisible();

  await page.getByRole("tab", { name: /Checks/ }).click();
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
