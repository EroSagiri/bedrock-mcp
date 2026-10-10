import { MemoryRouter, Route, Routes } from "react-router";
import { MemoryScreen } from "@mineral/textui";
import { Action, Block, Divider, Heading, Input, List, ListItem, Output, Screen, Table, Text, render } from "@mineral/textui-react";
import { adjacent, available, questRoom, type GamesState } from "./model";

export const actionId = (state: GamesState, name: string) => `g-${state.turn}-${name}`;
function Button({ state, name, label, disabled = false }: { state: GamesState; name: string; label: string; disabled?: boolean }) {
  return <Action id={actionId(state, name)} label={label} disabled={disabled} />;
}
function Lobby({ state }: { state: GamesState }) {
  return <><Heading level={2}>今天，玩哪一页？</Heading>
    <Text>一个文件就是一张共享游戏桌。你可以独自解谜，也可以让朋友打开同一个文件接力；每次只勾选一个行动，等界面更新再继续。</Text>
    <Heading level={3}>💣 矿区排雷 · 空间推理</Heading><Text>6×6 表格里藏着 8 枚矿雷。首步及周围保证安全，空白会连片展开；用数字推理，别只靠运气。</Text><Button state={state} name="play-mines" label={state.mines ? "继续矿区排雷" : "进入矿区排雷"} />
    <Heading level={3}>🔐 密码档案 · 逻辑破译</Heading><Text>4 个不重复的数字，8 次机会。每次告诉你“位置正确”和“存在但错位”的数量，把推理写在历史表格里。</Text><Button state={state} name="play-code" label={state.code ? "继续密码档案" : "打开密码档案"} />
    <Heading level={3}>📖 纸页地牢 · 分支冒险</Heading><Text>一趟 8 页的冒险：买药还是换遗物，冒险还是撤退？生命、金币、火把与故事决定你能走多远。</Text><Button state={state} name="play-quest" label={state.quest ? "继续纸页地牢" : "走进纸页地牢"} />
    <Divider /><Button state={state} name="records" label="查看共享战绩与成就" />
    <Text>回大厅会暂停并保留三种游戏。新一局只替换对应游戏；战绩继续累积。清空正文也会恢复，真正删除文件才会关闭这张游戏桌。</Text></>;
}
function MinesPage({ state }: { state: GamesState }) {
  const game = state.mines!;
  const ended = game.phase !== "playing";
  const rows = Array.from({ length: 6 }, (_, r) => Object.fromEntries([["row", r + 1], ...Array.from({ length: 6 }, (_, c) => {
    const cell = r * 6 + c;
    const value = game.bombs.includes(cell) && ended ? "💣" : game.flags.includes(cell) ? "🚩" : !game.open.includes(cell) ? "■" : adjacent(game, cell) || "·";
    return [String.fromCharCode(65 + c), value];
  })]));
  return <><Heading level={2}>💣 矿区排雷</Heading>
    <Output id="mines-progress" label="进度" value={`${game.open.filter(v => !game.bombs.includes(v)).length}/28 安全格 · ${game.flags.length}/8 面旗 · ${game.moves} 次翻开 · ${game.phase === "won" ? "胜利" : game.phase === "lost" ? "踩雷" : "进行中"}`} />
    <Table columns={[{ key: "row", title: "行 / 列" }, ...[..."ABCDEF"].map(key => ({ key, title: key }))]} rows={rows} />
    <Text>■ 未知　🚩 标记　· 周围无雷　数字 = 周围 8 格里的雷数。翻开全部 28 个安全格即获胜，不要求插满旗。</Text>
    {!ended ? <><Input id="entry" label="坐标" value={state.entry} /><Text>填写列字母 + 行数字，例如 B3，然后勾选行动。</Text><Button state={state} name="reveal" label="翻开这个格子" /><Button state={state} name="flag" label="插旗 / 收旗" /></> : null}
    <Button state={state} name="new-mines" label="开始新一局排雷（替换当前棋盘）" /><Button state={state} name="home" label="暂停并回大厅" /></>;
}
function CodePage({ state }: { state: GamesState }) {
  const game = state.code!;
  return <><Heading level={2}>🔐 密码档案</Heading><Text>密码由 0–9 中 4 个不同数字组成，允许 0 开头。位置正确的数字不会重复算进“错位”。</Text>
    <Output id="code-progress" label="档案" value={`${game.guesses.length}/8 次尝试 · ${game.phase === "won" ? "已破译" : game.phase === "lost" ? `密码 ${game.secret}` : "密码 ····"}`} />
    {game.guesses.length ? <Table columns={[{ key: "round", title: "次数" }, { key: "value", title: "尝试" }, { key: "exact", title: "位置正确" }, { key: "misplaced", title: "存在但错位" }]} rows={game.guesses.map((v, i) => ({ round: i + 1, ...v }))} /> : <Text>试一个组合，留下第一条线索。</Text>}
    {game.phase === "playing" ? <><Input id="entry" label="密码" value={state.entry} /><Button state={state} name="guess" label="提交这次推理" /><Text>无效或重复的组合不扣机会。答案只存在服务器，未结束前不会放进文件。</Text></> : null}
    <Button state={state} name="new-code" label="打开新档案（替换当前密码）" /><Button state={state} name="home" label="暂停并回大厅" /></>;
}
function QuestPage({ state }: { state: GamesState }) {
  const game = state.quest!, room = questRoom(game);
  return <><Heading level={2}>📖 纸页地牢</Heading>
    <Output id="quest-progress" label="背包" value={`第 ${Math.min(8, game.depth + 1)}/8 页 · 生命 ${game.hp}/12 · 金币 ${game.gold} · 火把 ${game.torches} · 药水 ${game.potions} · 遗物 ${game.relics}`} />
    <Block id="life" type="game-meter" lang="text" value={`${"♥".repeat(game.hp)}${"♡".repeat(12 - game.hp)}`} readOnly />
    {game.phase === "playing" ? <><Heading level={3}>{room.title}</Heading><Text>{room.story}</Text>
      {room.choices.map(choice => <Button key={choice.key} state={state} name={`choose-${choice.key}`} label={choice.label} disabled={!available(game, choice)} />)}
      <Divider /><Button state={state} name="heal" label="喝药水：恢复 5 点生命，不推进房间" disabled={!game.potions || game.hp === 12} /><Button state={state} name="retreat" label="带着已有收获撤退，结束本局" />
      <Text>生命归零只结算四分之一金币。主动撤退可保留金币、遗物和探索分；通关需要在第 8 页活着做出选择。</Text></> : <Heading level={3}>{game.phase === "won" ? "✨ 故事通关" : game.phase === "lost" ? "💫 被书页送回入口" : "🏕 带着收获归来"}</Heading>}
    <Heading level={3}>共享战报</Heading><List>{game.journal.map((line, i) => <ListItem key={i}><Text>{line}</Text></ListItem>)}</List>
    <Button state={state} name="new-quest" label="翻开新的故事（替换本次冒险）" /><Button state={state} name="home" label="暂停并回大厅" /></>;
}
function Records({ state }: { state: GamesState }) {
  const totalWins = Object.values(state.records).reduce((n, v) => n + v.wins, 0);
  return <><Heading level={2}>🏆 这张游戏桌的战绩</Heading><Text>{`累计积分：${state.points}。积分来自排雷、破译和冒险结算；属于本文件的参与者共同累积。`}</Text>
    <Table columns={[{ key: "name", title: "游戏" }, { key: "plays", title: "开局" }, { key: "wins", title: "胜利" }, { key: "best", title: "单局最高分" }]} rows={(["mines", "code", "quest"] as const).map((game, i) => ({ name: ["矿区排雷", "密码档案", "纸页地牢"][i], ...state.records[game] }))} />
    <Heading level={3}>成就清单</Heading><Text>{`${totalWins ? "☑" : "☐"} 第一场胜利\n\n${Object.values(state.records).every(v => v.plays > 0) ? "☑" : "☐"} 三种游戏都尝试过\n\n${state.points >= 500 ? "☑" : "☐"} 纸上高手：累计 500 分\n\n${Object.values(state.records).every(v => v.wins > 0) ? "☑" : "☐"} 全能玩家：三种游戏都获胜`}</Text>
    <Text>排雷胜利：max(50, 300 − 翻开次数 × 3)；密码胜利：350 − 尝试次数 × 30；冒险安全结算：金币 + 遗物 × 20 + 探索页数 × 5 + 剩余生命 × 2。</Text><Button state={state} name="home" label="返回大厅" /></>;
}
export async function renderGames(state: GamesState): Promise<string> {
  const host = new MemoryScreen(), errors: Error[] = [];
  const root = await render(<MemoryRouter initialEntries={[state.route]} useTransitions={false}><Screen>
    <Text>{"<!-- mineral:room-app=games -->"}</Text><Heading>🎮 纸上游乐场</Heading><Output id="game-status" label="桌边消息" value={state.status} /><Divider />
    <Routes><Route path="/" element={<Lobby state={state} />} /><Route path="/mines" element={<MinesPage state={state} />} /><Route path="/code" element={<CodePage state={state} />} /><Route path="/quest" element={<QuestPage state={state} />} /><Route path="/records" element={<Records state={state} />} /></Routes>
    <Text>{"<details><summary>游戏桌同步标记</summary>"}</Text><Block id="games-public" type="games-public" lang="json" value={JSON.stringify({ version: 1, turn: state.turn, route: state.route })} readOnly /><Text>{"</details>"}</Text>
  </Screen></MemoryRouter>, { host, screen: "main", onError: error => errors.push(error) });
  try { await root.idle(); await root.flush(); if (errors.length) throw errors[0]; return (await host.getScreen("main"))!.text; }
  finally { await root.unmount(); }
}
