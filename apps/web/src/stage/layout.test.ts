import { newScore } from "@musicraft/score-core";
import { describe, expect, it } from "vitest";
import { arrangeSeats, clampToStage, facingConductor, FIRST_ROW, floorHeight, RISER_STEP, rowCount, soundPositions } from "./layout";

const score = (instruments: string[]) => newScore({ title: "T", parts: instruments.map((instrument) => ({ instrument })), measures: 2 });

describe("seating", () => {
  it("seats a brass quintet in one arc, high instruments on the left, facing the conductor", () => {
    const quintet = score(["tuba", "trumpet-bb", "trombone", "horn-f", "trumpet-bb"]);
    const seats = arrangeSeats(quintet, "hall");
    expect(rowCount(seats)).toBe(1);
    const leftToRight = [...seats].sort((a, b) => a.x - b.x).map((s) => quintet.parts[s.partIndex]!.instrument);
    expect(leftToRight).toEqual(["trumpet-bb", "trumpet-bb", "horn-f", "trombone", "tuba"]);
    // The two trumpets keep score order: first trumpet (part 2) further left.
    expect(seats[1]!.x).toBeLessThan(seats[4]!.x);
    for (const seat of seats) {
      expect(Math.hypot(seat.x, seat.z)).toBeCloseTo(FIRST_ROW);
      expect(seat.rotation).toBeCloseTo(facingConductor(seat.x, seat.z));
      expect(seat.y).toBe(0);
    }
    expect(facingConductor(0, -3)).toBeCloseTo(0);
    expect(facingConductor(-3, 0)).toBeCloseTo(90);
  });

  it("puts a large band in several arcs on rising risers, low brass at the back", () => {
    // A British brass band: 25 players.
    const band = score([
      "soprano-cornet-eb",
      ...Array<string>(9).fill("cornet-bb"),
      "flugelhorn",
      ...Array<string>(3).fill("tenor-horn-eb"),
      ...Array<string>(2).fill("baritone-tc"),
      ...Array<string>(2).fill("trombone"),
      "bass-trombone",
      ...Array<string>(2).fill("euphonium-tc"),
      ...Array<string>(2).fill("bass-eb-tc"),
      ...Array<string>(2).fill("bass-bb-tc"),
    ]);
    const seats = arrangeSeats(band, "hall");
    expect(rowCount(seats)).toBeGreaterThan(1);
    const rowOf = (instrument: string) => seats.find((s) => band.parts[s.partIndex]!.instrument === instrument)!.row;
    expect(rowOf("bass-bb-tc")).toBeGreaterThan(rowOf("cornet-bb"));
    for (const seat of seats) expect(seat.y).toBeCloseTo(seat.row * RISER_STEP);
    // No two players on top of each other.
    for (const a of seats) for (const b of seats) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.9);
  });

  it("keeps players where they were dragged, on the stage and facing the conductor", () => {
    const duo = score(["trumpet-bb", "piano"]);
    const trumpet = duo.parts[0]!.id;
    const seats = arrangeSeats(duo, "hall", { [trumpet]: { x: 1, z: -4 } });
    expect(seats[0]).toMatchObject({ x: 1, z: -4 });
    expect(seats[0]!.rotation).toBeCloseTo(facingConductor(1, -4));
    // Not into the audience, and not off the back of the stage.
    expect(clampToStage("hall", 0, 3, 1).z).toBeLessThan(0);
    const far = clampToStage("hall", 0, -40, 1);
    expect(Math.hypot(far.x, far.z)).toBeLessThan(8);
    // On the bandstand everyone is on the raised floor.
    expect(arrangeSeats(duo, "bandstand").every((s) => s.y === 0.9)).toBe(true);
    expect(floorHeight("hall", 0, 2, 3)).toBe(0);
  });

  it("gives each part a place for its sound", () => {
    const solo = score(["piano"]);
    const [seat] = arrangeSeats(solo, "hall");
    expect(seat).toMatchObject({ x: 0, row: 0 });
    expect(soundPositions([seat!]).get(solo.parts[0]!.id)).toEqual({ x: 0, y: 1.1, z: -FIRST_ROW });
  });
});

describe("viewpoints", () => {
  it("looks at the players from every viewpoint", async () => {
    const { viewpoint } = await import("./layout");
    const quartet = score(["trumpet-bb", "trumpet-bb", "horn-f", "trombone"]);
    const seats = arrangeSeats(quartet, "hall");
    for (const id of ["overview", "conductor", "front-row", "balcony", "above"] as const) {
      const view = viewpoint(id, "hall", seats);
      // The camera looks towards the stage (behind the conductor, -z) or straight down.
      expect(view.target.z).toBeLessThanOrEqual(view.position.z);
    }
    const seat = seats[2]!;
    const fromSeat = viewpoint("seat", "hall", seats, seat);
    expect(Math.hypot(fromSeat.position.x - seat.x, fromSeat.position.z - seat.z)).toBeCloseTo(0.25);
    expect(fromSeat.target).toEqual({ x: 0, y: 1.5, z: 0 });
    expect(viewpoint("conductor", "bandstand", seats).position.y).toBeCloseTo(2.72);
  });
});

describe("keyboards", () => {
  it("puts the piano at the left end of its row", () => {
    const trio = score(["violin", "piano", "cello"]);
    const seats = arrangeSeats(trio, "hall");
    const piano = seats.find((s) => trio.parts[s.partIndex]!.instrument === "piano")!;
    expect(Math.min(...seats.map((s) => s.x))).toBe(piano.x);
  });
});
