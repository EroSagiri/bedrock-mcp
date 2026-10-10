import { describe, expect, it } from "vitest";
import { MemoryScreen, parseTextUI, patchValues } from "@mineral/textui";
import { gamesApp } from "../apps/room-apps/src/games/app";
import { actionId } from "../apps/room-apps/src/games/view";
import { adjacent, command, initialState, judge, neighbors, questRoom, reveal, type GamesState } from "../apps/room-apps/src/games/model";
import { roomApps } from "../apps/room-apps/src/registry";

async function harness() {
  const screen = new MemoryScreen();
  await screen.setScreen("main", "", { expectedRevision: null });
  let stored: GamesState;
  const controller = new AbortController();
  const context = { screen, screenId: "main", signal: controller.signal,
    state: { read: async () => structuredClone(stored), write: async (value: unknown) => { stored = structuredClone(value as GamesState); } },
    index: { query: async () => { throw new Error("Games must not query the vault"); } } };
  const text = async () => (await screen.getScreen("main"))!.text;
  const edit = async (values: Record<string, string | boolean> | string) => {
    const before = (await screen.getScreen("main"))!;
    await screen.setScreen("main", typeof values === "string" ? values : patchValues(parseTextUI(before.text), new Map(Object.entries(values))), { expectedRevision: before.revision });
    await gamesApp.run(context);
  };
  const act = (name: string, entry?: string) => edit({ [actionId(stored, name)]: true, ...(entry !== undefined ? { entry } : {}) });
  await gamesApp.run(context);
  return { screen, context, controller, text, edit, act, state: () => structuredClone(stored) };
}

describe("paper arcade rules", () => {
  it("registers only the exact games entry and isolates game state", () => {
    expect(roomApps.match("fun/games.ui.md")?.name).toBe("games");
    expect(roomApps.match("Games.ui.md")).toBeUndefined();
    expect(roomApps.match("games.md")).toBeUndefined();
    expect(initialState().records).not.toBe(initialState().records);
  });

  it("protects the first mine opening, floods zeros and generates eight distinct mines for all board edges", () => {
    for (let seed = 1; seed <= 20; seed++) for (const cell of [0, 5, 14, 30, 35]) {
      const state = initialState(); command(state, "play-mines", "", seed);
      const game = state.mines!; reveal(game, cell);
      expect(new Set(game.bombs).size).toBe(8);
      expect(game.bombs.some(v => [cell, ...neighbors(cell)].includes(v))).toBe(false);
      expect(game.open).toContain(cell); expect(adjacent(game, cell)).toBe(0);
      expect(game.open.some(v => game.bombs.includes(v))).toBe(false);
      expect(game.open.length).toBeGreaterThan(1);
    }
  });

  it("wins only by revealing all safe cells, settles once and rejects invalid/flagged cells", () => {
    const state = initialState(); command(state, "play-mines", "", 42);
    command(state, "reveal", "G9", 0); expect(state.mines!.started).toBe(false);
    command(state, "flag", "B3", 0); command(state, "reveal", "B3", 0);
    expect(state.mines!.open).toHaveLength(0);
    command(state, "flag", "B3", 0); command(state, "reveal", "B3", 0);
    for (let i = 0; i < 36; i++) if (!state.mines!.bombs.includes(i)) command(state, "reveal", `${String.fromCharCode(65 + i % 6)}${Math.floor(i / 6) + 1}`, 0);
    expect(state.mines!.phase).toBe("won"); expect(state.records.mines.wins).toBe(1);
    const points = state.points; command(state, "reveal", "B3", 0);
    expect(state.points).toBe(points); expect(state.records.mines.wins).toBe(1);
    command(state, "new-mines", "", 9); command(state, "reveal", "A1", 0);
    const bomb = state.mines!.bombs[0]; command(state, "reveal", `${String.fromCharCode(65 + bomb % 6)}${Math.floor(bomb / 6) + 1}`, 0);
    expect(state.mines!.phase).toBe("lost"); expect(state.records.mines.wins).toBe(1);
  });

  it("scores distinct digit deduction correctly and spends no guess on invalid or repeated entries", () => {
    expect(judge("0123", "0314")).toEqual({ value: "0314", exact: 1, misplaced: 2 });
    const state = initialState(); command(state, "play-code", "", 123);
    expect(new Set(state.code!.secret).size).toBe(4);
    for (const value of ["1111", "abc", "12345"]) command(state, "guess", value, 0);
    expect(state.code!.guesses).toHaveLength(0);
    const value = state.code!.secret === "1234" ? "5678" : "1234";
    command(state, "guess", value, 0); command(state, "guess", value, 0);
    expect(state.code!.guesses).toHaveLength(1);
    command(state, "guess", state.code!.secret, 0);
    expect(state.code!.phase).toBe("won"); expect(state.records.code.wins).toBe(1);
    const points = state.points; command(state, "guess", state.code!.secret, 0); expect(state.points).toBe(points);
  });

  it("ends the code game at eight guesses and reveals the answer only at the end", async () => {
    const app = await harness(); await app.act("play-code");
    const secret = app.state().code!.secret;
    expect(await app.text()).not.toContain(`"secret"`);
    expect(await app.text()).not.toContain(secret);
    const guesses = ["0123", "1234", "2345", "3456", "4567", "5678", "6789", "7890", "8901"].filter(v => v !== secret).slice(0, 8);
    for (const guess of guesses) await app.act("guess", guess);
    expect(app.state().code!.phase).toBe("lost"); expect(await app.text()).toContain(secret);
    expect(app.state().code!.guesses).toHaveLength(8);
  });

  it("makes reproducible adventures, refuses unaffordable choices, heals without advancing and settles retreat once", () => {
    const state = initialState(); command(state, "play-quest", "", 7);
    const twin = structuredClone(state);
    command(state, "choose-pry", "", 0); command(twin, "choose-pry", "", 0);
    expect(state.quest).toEqual(twin.quest);
    const game = state.quest!; game.gold = 0;
    const paid = questRoom(game).choices.find(v => (v.gold ?? 0) < 0);
    if (paid) { const before = structuredClone(game); command(state, `choose-${paid.key}`, "", 0); expect(game).toEqual(before); }
    game.hp = 4; const depth = game.depth; command(state, "heal", "", 0);
    expect(game.hp).toBe(9); expect(game.depth).toBe(depth); expect(game.potions).toBe(0);
    command(state, "retreat", "", 0); const points = state.points;
    expect(game.phase).toBe("banked"); command(state, "retreat", "", 0); expect(state.points).toBe(points);
  });

  it("offers viable paths to the final page with bounded resources and a single victory settlement", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const state = initialState(); command(state, "play-quest", "", seed);
      const game = state.quest!;
      for (let depth = 0; depth < 8; depth++) {
        const room = questRoom(game);
        const choice = room.choices.find(v => !v.risk && (v.hp ?? 0) >= 0 && game.gold + (v.gold ?? 0) >= 0 && game.torches + (v.torches ?? 0) >= 0 && game.relics + (v.relics ?? 0) >= 0) ?? room.choices[0];
        command(state, `choose-${choice.key}`, "", 0);
        expect(game.hp).toBeGreaterThan(0); expect(game.hp).toBeLessThanOrEqual(12);
        expect(game.gold).toBeGreaterThanOrEqual(0); expect(game.torches).toBeGreaterThanOrEqual(0);
      }
      expect(game.phase).toBe("won"); expect(state.records.quest.wins).toBe(1);
      command(state, "choose-fight", "", 0); expect(state.records.quest.wins).toBe(1);
    }
  });
});

describe("TSX games projection", () => {
  it("restores erased/damaged Markdown from private state and ignores forged public state", async () => {
    const app = await harness(); await app.act("play-mines"); await app.act("reveal", "A1");
    const game = app.state().mines;
    expect(await app.text()).not.toContain('"bombs"'); expect(await app.text()).not.toContain('"seed"');
    await app.edit(""); expect(app.state().mines).toEqual(game); expect(await app.text()).toContain("自动恢复");
    const text = await app.text(); await app.edit(text.replace(/坐标:[^\n]+/, "deleted input"));
    expect(app.state().mines).toEqual(game); expect(parseTextUI(await app.text()).controls.get("entry")?.value).toBe("A1");
    await app.edit((await app.text()).replace(/"turn":\d+/, '"turn":9000'));
    expect(app.state().mines).toEqual(game); expect(app.state().turn).toBe(2);
  });

  it("preserves drafts and paused games, ignores stale turns and rejects multiple actions", async () => {
    const app = await harness(); await app.act("play-code");
    await app.edit({ entry: "0011" }); expect(app.state().entry).toBe("0011");
    await app.act("guess"); expect(app.state().code!.guesses).toHaveLength(0); expect(app.state().entry).toBe("0011");
    const oldAction = actionId(app.state(), "guess"); await app.act("guess", "1234");
    const count = app.state().code!.guesses.length;
    await app.edit((await app.text()) + `\n- [x] stale <!-- textui:id=${oldAction} type=action -->\n`);
    expect(app.state().code!.guesses).toHaveLength(count);
    await app.edit({ [actionId(app.state(), "home")]: true, [actionId(app.state(), "new-code")]: true });
    expect(app.state().code!.guesses).toHaveLength(count); expect(app.state().route).toBe("/code");
    await app.act("home"); await app.act("play-quest"); await app.act("home"); await app.act("play-code");
    expect(app.state().code!.guesses).toHaveLength(count); expect(app.state().records.code.plays).toBe(1);
    await app.act("home"); await app.act("records"); expect(await app.text()).toContain("三种游戏都尝试过");
  });

  it("does not publish or mutate private state after cancellation", async () => {
    const app = await harness(), before = await app.text(), state = app.state();
    app.controller.abort(); await gamesApp.run(app.context);
    expect(await app.text()).toBe(before); expect(app.state()).toEqual(state);
  });
});
