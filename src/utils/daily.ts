import type { Env } from "../types";

export const DEFAULT_DAILY_NOTES_DIR = "daily";

export function normalizeDailyNotesDir(dir?: string | null): string {
  const normalized = (dir ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return normalized || DEFAULT_DAILY_NOTES_DIR;
}

export function getDailyNotesDir(env: Pick<Env, "DAILY_NOTES_DIR">, override?: string | null): string {
  return normalizeDailyNotesDir(override ?? env.DAILY_NOTES_DIR);
}

export function buildDailyNoteCandidates(date: string, dir: string): string[] {
  const dailyDir = normalizeDailyNotesDir(dir);
  return [
    `${dailyDir}/${date}.md`,
    `${dailyDir}/${date.replace(/-/g, "")}.md`,
    `${dailyDir}/${date.slice(0, 7)}/${date}.md`,
    `${dailyDir}/${date.slice(0, 4)}/${date}.md`,
  ];
}

export function buildDailyNoteKey(date: string, dir: string): string {
  return `${normalizeDailyNotesDir(dir)}/${date}.md`;
}
