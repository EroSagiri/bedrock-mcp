import { parseTextUI } from "@mineral/textui";
import type { RoomApp } from "../registry";
import { command, initialState, type GamesState } from "./model";
import { renderGames } from "./view";

function saved(value: unknown): value is GamesState {
  // This checkpoint is server-owned; the document contains only a public turn marker, never secrets.
  return !!value && typeof value === "object" && (value as GamesState).version === 1 &&
    Number.isSafeInteger((value as GamesState).turn) && !!(value as GamesState).records &&
    ["/", "/mines", "/code", "/quest", "/records"].includes((value as GamesState).route);
}
export const gamesApp: RoomApp = {
  name: "games",
  async run(context) {
    if (context.signal.aborted) return;
    if (!context.state) throw new Error("Games require private durable state");
    const snapshot = await context.screen.getScreen(context.screenId);
    if (!snapshot || context.signal.aborted) return;
    const cached = await context.state.read(), state = structuredClone(saved(cached) ? cached : initialState());
    const parsed = parseTextUI(snapshot.text);
    let marker: { turn?: number; route?: string } | null = null;
    try { marker = JSON.parse(parsed.blocks.get("games-public")?.value ?? "null"); } catch { /* Repair the public projection from private durable state. */ }
    const canonical = parseTextUI(await renderGames(state));
    const expected = [...canonical.controls].filter(([, c]) => c.type === "action" && !c.disabled).map(([id]) => id);
    const validProjection = saved(cached) && marker?.turn === state.turn && marker?.route === state.route &&
      [...canonical.controls].every(([id, c]) => parsed.controls.get(id)?.type === c.type);
    if (!validProjection) state.status = saved(cached) ? "游戏桌已自动恢复，进度与战绩保留。" : state.status;
    else {
      const input = parsed.controls.get("entry");
      if (input?.type === "input") state.entry = String(input.value).slice(0, 64);
      const checked = [...parsed.controls].filter(([, c]) => c.type === "action" && c.value === true).map(([id]) => id);
      if (checked.length === 1 && expected.includes(checked[0])) {
        command(state, checked[0].replace(`g-${state.turn}-`, ""), state.entry, crypto.getRandomValues(new Uint32Array(1))[0]);
        state.turn++;
      } else if (checked.length) { state.status = "每次只勾选一个当前行动；进度没有改变。"; state.turn++; }
    }
    const text = await renderGames(state);
    if (context.signal.aborted) return;
    await context.screen.setScreen(context.screenId, text, { expectedRevision: snapshot.revision, origin: "room-app:games" });
    if (!context.signal.aborted) await context.state.write(state);
  },
};
