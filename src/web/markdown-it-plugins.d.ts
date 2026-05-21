declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";

  const taskLists: MarkdownIt.PluginWithOptions<{
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }>;
  export default taskLists;
}

declare module "markdown-it-obsidian-callouts" {
  import type MarkdownIt from "markdown-it";

  const obsidianCallouts: MarkdownIt.PluginSimple;
  export default obsidianCallouts;
}
