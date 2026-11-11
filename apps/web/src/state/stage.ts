/** The 3D stage of the open project: which view is shown, the venue, and where players were moved. */
import { create } from "zustand";
import type { StageSettings } from "../lib/db";
import { getProject, saveStageSettings } from "../lib/projects";
import type { SeatOverride, Venue } from "../stage/layout";

export type MainView = "score" | "stage";

interface StageState extends StageSettings {
  projectId: string | null;
  /** The score or the 3D stage in the main area. */
  view: MainView;
  /** Hear the music from where the camera is (the stage view), or as plain stereo. */
  spatial: boolean;
  load(projectId: string): Promise<void>;
  close(): void;
  setView(view: MainView): void;
  setVenue(venue: Venue): void;
  setSpatial(spatial: boolean): void;
  moveSeat(partId: string, place: SeatOverride): void;
  resetSeats(): void;
}

const DEFAULTS: StageSettings = { venue: "hall", seats: {} };
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function rememberView(view: MainView) {
  try {
    localStorage.setItem("musicraft.mainView", view);
  } catch {
    // private mode: not remembered
  }
}

function rememberedView(): MainView {
  try {
    return localStorage.getItem("musicraft.mainView") === "stage" ? "stage" : "score";
  } catch {
    return "score";
  }
}

export const useStage = create<StageState>()((set, get) => {
  const persist = () => {
    const { projectId, venue, seats } = get();
    if (!projectId) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveStageSettings(projectId, { venue, seats }), 300);
  };
  return {
    ...DEFAULTS,
    projectId: null,
    view: "score",
    spatial: true,

    async load(projectId) {
      set({ ...DEFAULTS, projectId, view: rememberedView() });
      const project = await getProject(projectId);
      if (get().projectId === projectId && project?.stage) set({ venue: project.stage.venue, seats: project.stage.seats ?? {} });
    },
    close() {
      set({ ...DEFAULTS, projectId: null });
    },
    setView(view) {
      rememberView(view);
      set({ view });
    },
    setVenue(venue) {
      set({ venue });
      persist();
    },
    setSpatial(spatial) {
      set({ spatial });
    },
    moveSeat(partId, place) {
      set({ seats: { ...get().seats, [partId]: { x: Math.round(place.x * 100) / 100, z: Math.round(place.z * 100) / 100 } } });
      persist();
    },
    resetSeats() {
      set({ seats: {} });
      persist();
    },
  };
});
