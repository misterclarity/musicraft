import { create } from "zustand";
import { persist } from "zustand/middleware";

export type VisionOverride = "auto" | "on" | "off";

export interface Settings {
  /** Base URL of your server as seen from the internet, e.g. https://host.tailnet.ts.net */
  serverUrl: string;
  /** Your outside API key; sent only to serverUrl. */
  apiKey: string;
  /** Path of the OpenAI-compatible API below serverUrl. */
  llmPath: string;
  /** Path of the recognition service below serverUrl. */
  omrPath: string;
  /** Model id to use; empty means "use the detected model". */
  modelOverride: string;
  /** Context size in tokens; null means "use the detected value". */
  contextOverride: number | null;
  visionOverride: VisionOverride;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: (import.meta.env.VITE_DEFAULT_SERVER_URL as string | undefined) ?? "",
  apiKey: "",
  llmPath: "/v1",
  omrPath: "/omr",
  modelOverride: "",
  contextOverride: null,
  visionOverride: "auto",
};

interface SettingsState extends Settings {
  update: (changes: Partial<Settings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (changes) => set(changes),
      reset: () => set(DEFAULT_SETTINGS),
    }),
    { name: "musicraft.settings.v1" },
  ),
);

export function getSettings(): Settings {
  const { update: _update, reset: _reset, ...settings } = useSettings.getState();
  return settings;
}

export function isServerConfigured(settings: Settings): boolean {
  return settings.serverUrl.trim().length > 0;
}
