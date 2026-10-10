import { MemoryRouter, Route, Routes } from "react-router";
import { MemoryScreen } from "@mineral/textui";
import { Action, Block, Divider, Heading, Input, Link, List, ListItem, Output, Screen, Table, Text, render } from "@mineral/textui-react";
import { PAGE_SIZE, type Hit, type WorkbenchState } from "./app";

function Note({ hit }: { hit: Hit }) {
  return <><Link href={`obsidian://open?file=${encodeURIComponent(hit.key.replace(/\.md$/i, ""))}`}>{hit.title || hit.key}</Link><Text>{hit.key}</Text></>;
}
function Home({ state }: { state: WorkbenchState }) {
  return <>
    <Heading level={2}>知识库搜索</Heading>
    <Text>在方括号中输入关键词和目录，勾选“搜索”。模式可填：全文、向量、文件名。目录留空表示全部。</Text>
    <Text>向量检索可用一句话描述你要找的内容；无需与原文使用相同词语。</Text>
    <Divider />
    <Heading level={2}>快速入口</Heading>
    <Action id="recent" label="最近更新的笔记" />
    <Action id="orphans" label="检查孤立笔记" />
    <Action id="broken" label="检查失效链接" />
    <Heading level={2}>最近查询</Heading>
    {state.history.length ? state.history.map((item, index) => <Action key={index} id={`history-${index}`} label={`${item.mode} · ${item.query || "浏览"} · ${item.prefix || "全部目录"}`} />) : <Text>提交查询后，会保留最近 10 次查询。</Text>}
  </>;
}
function Results({ state }: { state: WorkbenchState }) {
  const pages = Math.max(1, Math.ceil(state.results.length / PAGE_SIZE));
  return <>
    <Heading level={2}>结果</Heading>
    <Text>{`${state.mode} · ${state.query || "浏览"} · ${state.prefix || "全部目录"}`}</Text>
    <Output id="page-status" label="分页" value={`第 ${state.page + 1}/${pages} 页 · 已取得 ${state.results.length} 项 · 每页 ${PAGE_SIZE} 项`} />
    <Text>{state.mode === "向量" ? "展示本次相关度排名前 50 个候选片段；同一笔记可能有多个片段。" : "展示本次索引排名前 200 项；缩小目录或查询可找到更精确的结果。"}</Text>
    {state.phase === "searching" ? <Text>正在搜索…</Text> : state.results.length ? <List>{state.results.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE).map((hit, index) => {
      const ordinal = state.page * PAGE_SIZE + index;
      return <ListItem key={ordinal}>
        <Note hit={hit} />
        {state.mode === "向量" && hit.score !== undefined ? <Text>{`相关度：${hit.score.toFixed(3)}`}</Text> : null}
        <Block id={`hit-${ordinal}`} type="search-snippet" lang="text" value={hit.snippet} readOnly />
        <Action id={`bookmark-${ordinal}`} label={state.saved.some(v => v.key === hit.key) ? "已收藏" : "收藏此笔记"} disabled={state.saved.some(v => v.key === hit.key)} />
      </ListItem>;
    })}</List> : <Text>{state.status.startsWith("索引可用") ? "没有匹配的笔记。" : "本次未取得搜索结果。"}</Text>}
    <Action id="prev" label="上一页" disabled={state.page === 0 || state.phase === "searching"} />
    <Action id="next" label="下一页" disabled={state.page + 1 >= pages || state.phase === "searching"} />
    <Action id="back" label="返回工作台首页" />
  </>;
}
function Management({ state }: { state: WorkbenchState }) {
  const health = state.health;
  return <>
    <Heading level={2}>知识库管理</Heading>
    <Text>检查服务器全文和向量索引的就绪状态。刷新会按现有审计流程追踪索引欠账。</Text>
    {health ? <Table columns={[{ key: "name", title: "项目" }, { key: "value", title: "当前状态" }]} rows={[
      { name: "全文索引", value: health.ready ? "可用" : "不可用或未初始化" },
      { name: "已索引笔记", value: health.documents }, { name: "全文待更新", value: health.stale },
      { name: "向量服务", value: health.vectorAvailable ? "已连接" : "不可用" },
      { name: "向量就绪笔记", value: health.vectors }, { name: "向量待更新", value: health.owed },
      { name: "检查时间", value: health.checked },
    ]} /> : <Text>正在加载索引状态…</Text>}
    <Action id="refresh-health" label="刷新状态" />
    <Action id="refresh-index" label="触发索引审计与刷新" />
    <Divider />
    <Action id="recent" label="浏览最近更新" /><Action id="orphans" label="找出孤立笔记" /><Action id="broken" label="检查失效链接" />
    <Text>这些检查直接读取服务器索引；不会修改或删除笔记。</Text>
    <Action id="back" label="返回工作台首页" />
  </>;
}
function Saved({ state }: { state: WorkbenchState }) {
  return <><Heading level={2}>共享收藏</Heading><Text>收藏和查询历史属于当前工作台，参与这个文件的设备会共享它们。最多保留 50 篇收藏。</Text>
    {state.saved.length ? <List>{state.saved.map((hit, index) => <ListItem key={hit.key}><Note hit={hit} /><Action id={`remove-${index}`} label="移除收藏" /></ListItem>)}</List> : <Text>在搜索结果中勾选“收藏此笔记”添加收藏。</Text>}
    <Action id="back" label="返回工作台首页" />
  </>;
}
export async function renderWorkbench(state: WorkbenchState): Promise<string> {
  const host = new MemoryScreen();
  const errors: Error[] = [];
  const root = await render(<MemoryRouter initialEntries={[state.route]} useTransitions={false}>
    <Screen>
      <Text>{"<!-- mineral:room-app=workbench -->"}</Text>
      <Heading>知识库工作台</Heading>
      <Input id="query" label="关键词" value={state.draft.query} />
      <Input id="prefix" label="目录" value={state.draft.prefix} />
      <Input id="mode" label="模式" value={state.draft.mode} />
      <Action id="search" label="搜索" /><Action id="manage" label="知识库管理" /><Action id="saved" label="查看共享收藏" />
      <Output id="index-status" label="状态" value={state.status} />
      <Divider />
      <Routes><Route path="/" element={<Home state={state} />} /><Route path="/results" element={<Results state={state} />} /><Route path="/manage" element={<Management state={state} />} /><Route path="/saved" element={<Saved state={state} />} /></Routes>
      <Text>{"<details><summary>工作台恢复记录</summary>"}</Text>
      <Block id="workbench-state" type="workbench-state" lang="json" value={JSON.stringify(state)} readOnly />
      <Text>{"</details>"}</Text>
    </Screen>
  </MemoryRouter>, { host, screen: "main", onError: error => errors.push(error) });
  try {
    await root.idle(); await root.flush(); if (errors.length) throw errors[0]; return (await host.getScreen("main"))!.text;
  } finally { await root.unmount(); }
}
