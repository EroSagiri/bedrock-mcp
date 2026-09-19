import { z } from "zod";
import { type McpRegistrationContext } from "./shared";

function prompt(text: string, description: string) {
  return {
    description,
    messages: [{
      role: "user" as const,
      content: { type: "text" as const, text },
    }],
  };
}

export function registerBedrockPrompts(ctx: McpRegistrationContext): void {
  ctx.server.registerPrompt(
    "prompt_note_organize",
    {
      title: "整理笔记",
      description: "读取并整理一篇笔记，优先生成结构建议和 diff，不直接写入。",
      argsSchema: {
        key: z.string().min(1).describe("要整理的笔记 key"),
        style: z.enum(["concise", "detailed"]).optional().describe("整理粒度，默认 concise"),
      },
    },
    ({ key, style }) => prompt(
      [
        `请整理笔记 ${key}，风格为 ${style ?? "concise"}。`,
        "",
        "工作流：",
        "1. 使用 doc_read 读取笔记，并查看 frontmatter、tags、wikilinks 和正文。",
        "2. 判断标题层级、段落顺序、frontmatter、标签和链接是否需要调整。",
        "3. 先给出整理思路和风险点。",
        "4. 如需修改，使用 doc_preview_diff 生成预览 diff；只有用户明确同意后再使用 doc_patch 或 doc_write。",
        "",
        "输出：先给摘要，再给建议结构，最后给可执行的下一步。",
      ].join("\n"),
      "整理指定笔记"
    )
  );

  ctx.server.registerPrompt(
    "prompt_weekly_report",
    {
      title: "生成周报",
      description: "按日期范围汇总最近笔记，生成一份可直接使用的周报。",
      argsSchema: {
        startDate: z.string().min(1).describe("开始日期，例如 2026-04-20"),
        endDate: z.string().min(1).describe("结束日期，例如 2026-04-26"),
        prefix: z.string().optional().describe("可选目录前缀，例如 daily/"),
      },
    },
    ({ startDate, endDate, prefix }) => prompt(
      [
        `请根据 ${startDate} 到 ${endDate} 的笔记生成周报。`,
        prefix ? `优先搜索目录：${prefix}` : "如无目录限制，请跨整个 vault 搜索。",
        "",
        "工作流：",
        "1. 使用 vault_recent、search_text 或 res_doc_daily 找到日期范围内的候选笔记。",
        "2. 使用 doc_read_multiple 或 doc_read 读取关键笔记。",
        "3. 汇总完成事项、进行中事项、风险阻塞、重要决策和下周计划。",
        "4. 不要写入文件，除非用户明确要求保存。",
        "",
        "输出格式：周报标题、概览、完成、进行中、风险、下周计划。",
      ].join("\n"),
      "生成日期范围周报"
    )
  );

  ctx.server.registerPrompt(
    "prompt_meeting_to_tasks",
    {
      title: "会议记录转任务",
      description: "把会议笔记转换为任务清单、决策和待确认问题。",
      argsSchema: {
        key: z.string().min(1).describe("会议记录 key"),
        assignee: z.string().optional().describe("默认负责人"),
      },
    },
    ({ key, assignee }) => prompt(
      [
        `请把会议记录 ${key} 转换成任务清单。`,
        assignee ? `默认负责人：${assignee}` : "如果记录中没有负责人，请标记为待分配。",
        "",
        "工作流：",
        "1. 使用 doc_read 读取会议记录。",
        "2. 提取行动项、负责人、截止日期、依赖、决策和待确认问题。",
        "3. 对含糊任务给出需要追问的问题。",
        "4. 如要回写原笔记，先用 doc_preview_diff 生成 diff，不要直接覆盖。",
        "",
        "输出格式：任务清单、决策、待确认、建议追加到原文的 markdown。",
      ].join("\n"),
      "会议记录转任务清单"
    )
  );

  ctx.server.registerPrompt(
    "prompt_vault_maintenance",
    {
      title: "知识库维护计划",
      description: "检查链接、孤立笔记、标签和结构，生成维护计划。",
      argsSchema: {
        prefix: z.string().optional().describe("可选目录前缀"),
        focus: z.enum(["deadLinks", "orphans", "duplicates", "all"]).optional().describe("维护重点，默认 all"),
      },
    },
    ({ prefix, focus }) => prompt(
      [
        `请为这个 vault 生成维护计划，重点：${focus ?? "all"}。`,
        prefix ? `只检查目录：${prefix}` : "检查整个 vault。",
        "",
        "工作流：",
        "1. 使用 graph_get、graph_find_orphans、tag_list、vault_list_folders 和 search_text 了解结构。",
        "2. 找出死链、孤立笔记、标签混乱、目录命名不一致和可能重复的主题。",
        "3. 给出低风险优先的维护顺序。",
        "4. 不执行删除、移动、重命名或写入；只生成计划和建议命令。",
        "",
        "输出格式：健康概览、问题列表、推荐顺序、需要用户确认的危险操作。",
      ].join("\n"),
      "生成知识库维护计划"
    )
  );
}
