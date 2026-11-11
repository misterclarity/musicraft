import { INSTRUMENTS } from "@musicraft/score-core";
import { describe, expect, it } from "vitest";
import { modelKind, playerModel } from "./models";

describe("player models", () => {
  it("has a model for every instrument in the catalog, with sensible shapes", () => {
    for (const instrument of INSTRUMENTS) {
      const model = playerModel(instrument.id);
      expect(model.kind, instrument.id).not.toBe(instrument.id === "generic-treble" || instrument.id === "generic-bass" ? "x" : "generic");
      expect(model.body.length).toBeGreaterThan(5);
      if (model.kind !== "generic") expect(model.instrument.length, instrument.id).toBeGreaterThan(0);
      for (const shape of [...model.body, ...model.instrument]) {
        expect(shape.size.every((n) => Number.isFinite(n) && n >= 0), `${instrument.id} ${shape.kind}`).toBe(true);
        expect([...shape.position, ...(shape.rotation ?? [])].every(Number.isFinite)).toBe(true);
        // Everything stays within reach of the chair.
        expect(Math.abs(shape.position[0])).toBeLessThan(1);
        expect(shape.position[1]).toBeGreaterThanOrEqual(-0.01);
        expect(shape.position[1]).toBeLessThan(2.2);
      }
      expect(model.bell[1]).toBeGreaterThan(0.3);
    }
    expect(modelKind("cornet-bb")).toBe("cornet");
    expect(modelKind("generic-treble")).toBe("generic");
  });

  it("seats instrumentalists and stands singers up", () => {
    expect(playerModel("trumpet-bb")).toMatchObject({ standing: false, stand: true });
    expect(playerModel("soprano")).toMatchObject({ standing: true, stand: false });
    expect(playerModel("piano")).toMatchObject({ standing: false, stand: false });
  });
});
