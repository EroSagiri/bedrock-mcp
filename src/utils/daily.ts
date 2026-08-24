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

export function parseDailyDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? parsed
    : null;
}

export function formatDailyDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function shiftDailyDate(value: string, days: number): string | null {
  const date = parseDailyDate(value);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return formatDailyDate(date);
}

export function renderFixedDailyNote(date: string, content: string): string | null {
  const yesterday = shiftDailyDate(date, -1);
  const tomorrow = shiftDailyDate(date, 1);
  if (!yesterday || !tomorrow) return null;
  const body = content.trim();
  return [
    "---",
    "tags: [日记]",
    `date: ${date}`,
    "---",
    "",
    body,
    "",
    "---",
    `<< [[${yesterday}]] | [[${tomorrow}]] >>`,
    "",
  ].join("\n");
}
