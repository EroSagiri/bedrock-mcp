import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_NOTES_DIR,
  buildDailyNoteCandidates,
  buildDailyNoteKey,
  getDailyNotesDir,
  normalizeDailyNotesDir,
} from "../src/utils/daily";

describe("daily note path helpers", () => {
  it("defaults to daily when nothing is configured", () => {
    expect(DEFAULT_DAILY_NOTES_DIR).toBe("daily");
    expect(normalizeDailyNotesDir()).toBe("daily");
    expect(getDailyNotesDir({ DAILY_NOTES_DIR: undefined })).toBe("daily");
  });

  it("normalizes separators and trims wrapping slashes", () => {
    expect(normalizeDailyNotesDir(" /journal\\daily/ ")).toBe("journal/daily");
  });

  it("prefers explicit overrides over env configuration", () => {
    expect(getDailyNotesDir({ DAILY_NOTES_DIR: "journals" }, "daily")).toBe("daily");
  });

  it("builds candidate keys under the resolved directory", () => {
    expect(buildDailyNoteKey("2026-05-22", "daily")).toBe("daily/2026-05-22.md");
    expect(buildDailyNoteCandidates("2026-05-22", "daily")).toEqual([
      "daily/2026-05-22.md",
      "daily/20260522.md",
      "daily/2026-05/2026-05-22.md",
      "daily/2026/2026-05-22.md",
    ]);
  });
});
