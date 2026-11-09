import { describe, expect, it } from "vitest";
import { diagnoseRecognition } from "./diagnose";
import { ServerError } from "./server";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

const settings: Settings = { ...DEFAULT_SETTINGS, serverUrl: "https://box.example.ts.net" };
const url = "https://box.example.ts.net/omr/health";

describe("recognition service diagnosis", () => {
  it("explains a missing gateway route", () => {
    const d = diagnoseRecognition(new ServerError("http", "Not found", url, 404), settings, true);
    expect(d.cause).toContain("404");
    expect(d.steps.join(" ")).toContain("Add the /omr route to gateway.py");
    expect(d.curl).toBe(`curl -i -H "Authorization: Bearer YOUR_API_KEY" ${url}`);
  });

  it("points at CORS when the model works but /omr gives no usable answer", () => {
    const d = diagnoseRecognition(new ServerError("network", "Couldn't reach", url), settings, true);
    expect(d.cause).toContain("no /omr route yet");
    expect(d.steps.some((s) => s.includes("CORS"))).toBe(true);
  });

  it("tells key problems and a stopped container apart", () => {
    expect(diagnoseRecognition(new ServerError("http", "x", url, 401), settings, true).cause).toContain("key was refused");
    expect(diagnoseRecognition(new ServerError("http", "x", url, 502), settings, true).steps[0]).toContain("docker compose ps");
    expect(diagnoseRecognition(new ServerError("parse", "x", url), settings, true).cause).toContain("not the recognition service");
  });
});
