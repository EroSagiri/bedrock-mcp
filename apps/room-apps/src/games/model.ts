export type Game = "mines" | "code" | "quest";
export type Phase = "playing" | "won" | "lost" | "banked";
export type Mines = { seed: number; bombs: number[]; open: number[]; flags: number[]; moves: number; phase: Phase; started: boolean };
export type Guess = { value: string; exact: number; misplaced: number };
export type Code = { secret: string; guesses: Guess[]; phase: Phase };
export type Quest = { seed: number; depth: number; hp: number; gold: number; torches: number; potions: number; relics: number; phase: Phase; journal: string[] };
export type GamesState = {
  version: 1; turn: number; route: "/" | "/mines" | "/code" | "/quest" | "/records";
  entry: string; status: string; mines: Mines | null; code: Code | null; quest: Quest | null;
  records: Record<Game, { plays: number; wins: number; best: number }>; points: number;
};
export const initialState = (): GamesState => ({ version: 1, turn: 0, route: "/", entry: "", status: "欢迎来到纸上游乐场，选一场游戏开始。", mines: null, code: null, quest: null,
  records: { mines: { plays: 0, wins: 0, best: 0 }, code: { plays: 0, wins: 0, best: 0 }, quest: { plays: 0, wins: 0, best: 0 } }, points: 0 });

function random(seed: number) {
  let value = seed >>> 0 || 1;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
}
function shuffled<T>(items: T[], seed: number): T[] {
  const next = random(seed), result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function neighbors(cell: number): number[] {
  const row = Math.floor(cell / 6), col = cell % 6, result: number[] = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const r = row + dr, c = col + dc;
    if ((dr || dc) && r >= 0 && r < 6 && c >= 0 && c < 6) result.push(r * 6 + c);
  }
  return result;
}
export const adjacent = (game: Mines, cell: number) => neighbors(cell).filter(v => game.bombs.includes(v)).length;
export function coordinate(value: string): number | null {
  const match = /^([a-f])([1-6])$/i.exec(value.trim());
  return match ? (Number(match[2]) - 1) * 6 + match[1].toUpperCase().charCodeAt(0) - 65 : null;
}
export const cellName = (cell: number) => `${String.fromCharCode(65 + cell % 6)}${Math.floor(cell / 6) + 1}`;
export function reveal(game: Mines, cell: number): string {
  if (game.phase !== "playing") return "这一局已结束，可以回大厅或开新局。";
  if (game.flags.includes(cell)) return "先取消这个格子的旗帜，再翻开。";
  if (game.open.includes(cell)) return "这个格子已经翻开。";
  if (!game.started) {
    const safe = new Set([cell, ...neighbors(cell)]);
    game.bombs = shuffled(Array.from({ length: 36 }, (_, i) => i).filter(i => !safe.has(i)), game.seed).slice(0, 8);
    game.started = true;
  }
  game.moves++;
  if (game.bombs.includes(cell)) { game.open.push(cell); game.phase = "lost"; return `${cellName(cell)} 踩到矿雷！棋盘已揭晓，下次再来。`; }
  const pending = [cell], open = new Set(game.open);
  while (pending.length) {
    const current = pending.pop()!;
    if (open.has(current) || game.flags.includes(current) || game.bombs.includes(current)) continue;
    open.add(current);
    if (adjacent(game, current) === 0) pending.push(...neighbors(current));
  }
  game.open = [...open].sort((a, b) => a - b);
  if (game.open.length === 28) { game.phase = "won"; return "矿区全部排除！你们是可靠的探险队。"; }
  return `${cellName(cell)} 已翻开；还有 ${28 - game.open.length} 个安全格。`;
}
export function judge(secret: string, value: string): Guess {
  const exact = [...value].filter((v, i) => secret[i] === v).length;
  return { value, exact, misplaced: [...value].filter(v => secret.includes(v)).length - exact };
}

type Choice = { key: string; label: string; hp?: number; gold?: number; torches?: number; potions?: number; relics?: number; risk?: number; damage?: number };
type Room = { title: string; story: string; choices: Choice[] };
const rooms: Room[] = [
  { title: "遗忘的补给箱", story: "箱上写着：留一点给后来的人。箱底还有一个上锁的暗格。", choices: [
    { key: "supplies", label: "取补给：药水 +1、火把 +1", potions: 1, torches: 1 },
    { key: "pry", label: "撬开暗格：金币 +24，50% 受伤 4 点", gold: 24, risk: .5, damage: 4 },
    { key: "leave", label: "给后来者留言：生命 +2、金币 +8", hp: 2, gold: 8 }] },
  { title: "会索要名字的桥", story: "石桥问：名字和金币，你愿意留下哪一样？水下的倒影比你慢半拍。", choices: [
    { key: "pay", label: "付桥费：金币 −8，安全通过", gold: -8 },
    { key: "shadow", label: "让影子先走：金币 +18，50% 受伤 5 点", gold: 18, risk: .5, damage: 5 },
    { key: "light", label: "烧掉倒影：火把 −1、遗物 +1", torches: -1, relics: 1 }] },
  { title: "蘑菇邮局", story: "信封里装着微光。邮差说：有一封寄给未来的你。", choices: [
    { key: "letter", label: "拆自己的信：生命 +4", hp: 4 },
    { key: "deliver", label: "替邮差送信：金币 +16、火把 +1", gold: 16, torches: 1 },
    { key: "parcel", label: "买神秘包裹：金币 −10、遗物 +1", gold: -10, relics: 1 }] },
  { title: "齿轮守卫", story: "一台古老的守卫挡住路。它的胸口有金币，背后有一枚忘记上紧的螺丝。", choices: [
    { key: "fight", label: "正面拆解：生命 −4、金币 +28", hp: -4, gold: 28 },
    { key: "sneak", label: "绕到背后：遗物 +1，50% 受伤 6 点", relics: 1, risk: .5, damage: 6 },
    { key: "distract", label: "用火光引开：火把 −1、金币 +12", torches: -1, gold: 12 }] },
  { title: "地下星空", story: "这里的天花板是一片星空。每颗星都像一枚丢失的棋子。", choices: [
    { key: "rest", label: "数星星休息：生命 +3", hp: 3 },
    { key: "star", label: "摘下星星：生命 −2、遗物 +1", hp: -2, relics: 1 },
    { key: "map", label: "抄录星图：金币 +20", gold: 20 }] },
  { title: "只收故事的商店", story: "老板举起空茶杯：说一个故事，或者把口袋里的硬币给我。", choices: [
    { key: "story", label: "讲勇敢的故事：金币 +12、生命 +1", gold: 12, hp: 1 },
    { key: "medicine", label: "买急救包：金币 −12、药水 +2", gold: -12, potions: 2 },
    { key: "relic", label: "换古老指南针：金币 −18、遗物 +1", gold: -18, relics: 1 }] },
];
export function questRoom(game: Quest): Room {
  if (game.depth === 7) return { title: "末页之龙", story: "一本书的最后一页站了起来。它说：只有带着故事的人，才能把结局带回去。", choices: [
    { key: "fight", label: `迎战末页之龙：生命 −${game.relics >= 2 ? 5 : 9}、金币 +50`, hp: game.relics >= 2 ? -5 : -9, gold: 50 },
    { key: "light", label: "点亮出口：火把 −2、金币 +35", torches: -2, gold: 35 },
    { key: "offering", label: "献出一件遗物：遗物 −1、金币 +40", relics: -1, gold: 40 }] };
  const order = shuffled([1, 2, 3, 4, 5], game.seed);
  return rooms[game.depth === 0 ? 0 : order[(game.depth - 1) % order.length]];
}
export function available(game: Quest, choice: Choice): boolean {
  return game.gold + (choice.gold ?? 0) >= 0 && game.torches + (choice.torches ?? 0) >= 0 && game.relics + (choice.relics ?? 0) >= 0;
}
function finish(state: GamesState, game: Game, won: boolean, score: number) {
  if (won) state.records[game].wins++;
  state.records[game].best = Math.max(state.records[game].best, score);
  state.points += score;
}
export function command(state: GamesState, action: string, entry: string, seed: number): void {
  if (action === "home" || action === "records") { state.route = action === "home" ? "/" : "/records"; state.entry = ""; state.status = "进度已保留，随时回来接着玩。"; return; }
  const start = /^(play|new)-(mines|code|quest)$/.exec(action);
  if (start) {
    const game = start[2] as Game;
    if (start[1] === "new" || !state[game]) {
      if (game === "mines") state.mines = { seed, bombs: [], open: [], flags: [], moves: 0, phase: "playing", started: false };
      if (game === "code") state.code = { secret: shuffled([..."0123456789"], seed).slice(0, 4).join(""), guesses: [], phase: "playing" };
      if (game === "quest") state.quest = { seed, depth: 0, hp: 12, gold: 12, torches: 2, potions: 1, relics: 0, phase: "playing", journal: ["带着两根火把和一点勇气，走进纸页之间。"] };
      state.records[game].plays++;
    }
    state.route = `/${game}`; state.entry = ""; state.status = "新的一页，由你来决定。"; return;
  }
  if (state.route === "/mines" && state.mines && ["reveal", "flag"].includes(action)) {
    const game = state.mines, cell = coordinate(entry);
    if (cell === null) { state.status = "坐标请填 A1–F6，例如 B3。"; return; }
    const before = game.phase;
    if (action === "reveal") state.status = reveal(game, cell);
    else if (game.phase !== "playing") state.status = "这一局已结束。";
    else if (game.open.includes(cell)) state.status = "已翻开的格子不能插旗。";
    else if (game.flags.includes(cell)) { game.flags = game.flags.filter(v => v !== cell); state.status = `${cellName(cell)} 的旗帜已收起。`; }
    else if (game.flags.length === 8) state.status = "最多插 8 面旗；先收起一面。";
    else { game.flags.push(cell); state.status = `${cellName(cell)} 已标记，旗帜不代表这里一定有雷。`; }
    if (before === "playing" && game.phase !== before) finish(state, "mines", game.phase === "won", game.phase === "won" ? Math.max(50, 300 - game.moves * 3) : 0);
    return;
  }
  if (state.route === "/code" && state.code && action === "guess") {
    const game = state.code, value = entry.trim();
    if (game.phase !== "playing") { state.status = "这一局已结束，可以回看推理记录。"; return; }
    if (!/^\d{4}$/.test(value) || new Set(value).size !== 4) { state.status = "请输入 4 个不同的数字，允许以 0 开头，例如 0372；本次不扣机会。"; return; }
    if (game.guesses.some(v => v.value === value)) { state.status = "这个组合已经试过，本次不扣机会。"; return; }
    const result = judge(game.secret, value); game.guesses.push(result); state.entry = "";
    if (result.exact === 4) { game.phase = "won"; state.status = "密码正确！这份推理记录值得保存。"; finish(state, "code", true, 350 - game.guesses.length * 30); }
    else if (game.guesses.length === 8) { game.phase = "lost"; state.status = `机会用尽，密码是 ${game.secret}。再来一局？`; finish(state, "code", false, 0); }
    else state.status = `${result.exact} 个数字位置正确，${result.misplaced} 个数字存在但位置不对。`;
    return;
  }
  if (state.route === "/quest" && state.quest) {
    const game = state.quest;
    if (game.phase !== "playing") { state.status = "冒险已经结束，战报已留下。"; return; }
    if (action === "heal") {
      if (!game.potions || game.hp === 12) { state.status = "没有药水或生命已满，本次不消耗资源。"; return; }
      game.potions--; game.hp = Math.min(12, game.hp + 5); state.status = "喝下一瓶药水，恢复 5 点生命；仍在当前房间。"; game.journal.push(state.status); return;
    }
    if (action === "retreat") { game.phase = "banked"; state.status = "带着已有收获返回，活着也是一种胜利。"; }
    else {
      const room = questRoom(game), choice = room.choices.find(v => `choose-${v.key}` === action);
      if (!choice) return;
      if (!available(game, choice)) { state.status = "资源不足，换一个选择；本次不推进房间。"; return; }
      const hurt = random(game.seed ^ ((game.depth + 1) * 2654435761))() < (choice.risk ?? 0) ? choice.damage ?? 0 : 0;
      game.hp = Math.max(0, Math.min(12, game.hp + (choice.hp ?? 0) - hurt));
      game.gold += choice.gold ?? 0; game.torches += choice.torches ?? 0; game.potions += choice.potions ?? 0; game.relics += choice.relics ?? 0;
      game.depth++;
      state.status = `${room.title}：${choice.label}${choice.risk ? hurt ? `；不走运，受伤 ${hurt} 点。` : "；幸运地避开了危险。" : "。"}`;
      if (!game.hp) { game.phase = "lost"; state.status += "你被书页送回入口，只带回一部分收获。"; }
      else if (game.depth === 8) { game.phase = "won"; state.status += game.relics >= 3 ? "你带回星图与故事，成为纸页守护者！" : "你越过末页之龙，带着故事归来！"; }
    }
    game.journal = [...game.journal, state.status].slice(-16);
    if (game.phase !== "playing") finish(state, "quest", game.phase === "won", game.phase === "lost" ? Math.floor(game.gold / 4) : game.gold + game.relics * 20 + game.depth * 5 + game.hp * 2);
  }
}
