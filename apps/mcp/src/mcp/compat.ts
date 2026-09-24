import {
  ResourceTemplate,
  type McpServer,
  type ReadResourceCallback,
  type ReadResourceTemplateCallback,
  type CallToolResult,
  type ToolAnnotations,
  type RegisteredResource,
  type RegisteredResourceTemplate,
  type RegisteredTool,
  type ResourceMetadata,
} from "@modelcontextprotocol/server";
import { z } from "zod";

type ToolRisk = "read" | "write" | "destructive";
type ToolCategory = "documents" | "files" | "search" | "links" | "graph" | "vault";

type ToolShape = Record<string, z.ZodType>;

type ToolCompatConfig<Args extends ToolShape> = {
  title?: string;
  description?: string;
  inputSchema: Args;
  outputSchema?: ToolShape;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

const TOOL_METADATA: Record<string, {
  category: ToolCategory;
  risk: ToolRisk;
  title: string;
  description: string;
}> = {
  doc_read: {
    category: "documents",
    risk: "read",
    title: "Read document",
    description: "Read one text document and optionally parse frontmatter, tags, and wikilinks.",
  },
  doc_write: {
    category: "documents",
    risk: "destructive",
    title: "Write document",
    description: "Create or overwrite a text document in the vault.",
  },
  doc_preview_diff: {
    category: "documents",
    risk: "read",
    title: "Preview document diff",
    description: "Compare existing document content with proposed content without writing changes.",
  },
  doc_patch: {
    category: "documents",
    risk: "destructive",
    title: "Apply document patch",
    description: "Apply a unified diff patch to a document, with dry-run support.",
  },
  doc_backup: {
    category: "documents",
    risk: "write",
    title: "Back up document",
    description: "Copy one text document into the .history area.",
  },
  doc_restore: {
    category: "documents",
    risk: "destructive",
    title: "Restore document",
    description: "Restore a text backup to a target document key.",
  },
  doc_create: {
    category: "documents",
    risk: "write",
    title: "Create document",
    description: "Create a new text document and fail if it already exists.",
  },
  doc_append: {
    category: "documents",
    risk: "write",
    title: "Append to document",
    description: "Append content to a text document, optionally creating it first.",
  },
  doc_read_multiple: {
    category: "documents",
    risk: "read",
    title: "Read multiple documents",
    description: "Read up to 20 documents in one tool call.",
  },
  file_delete: {
    category: "files",
    risk: "destructive",
    title: "Delete file",
    description: "Move a file to .trash or permanently delete it.",
  },
  file_delete_many: {
    category: "files",
    risk: "destructive",
    title: "Delete many files",
    description: "Move files to .trash or permanently delete them in bulk.",
  },
  file_upload_binary: {
    category: "files",
    risk: "write",
    title: "Upload binary file",
    description: "Upload a base64-encoded binary object into the vault.",
  },
  file_public_url: {
    category: "files",
    risk: "read",
    title: "Get public file URL",
    description: "Build a public static URL and markdown embed for a stored file.",
  },
  file_create_access_token: {
    category: "files",
    risk: "read",
    title: "Create static access token",
    description: "Create a short-lived Bearer token for reading static files under a path prefix.",
  },
  file_create_folder: {
    category: "files",
    risk: "write",
    title: "Create folder placeholder",
    description: "Create a folder-like prefix by writing an empty .keep object.",
  },
  file_move: {
    category: "files",
    risk: "destructive",
    title: "Move file",
    description: "Move or rename an object inside the vault.",
  },
  search_text: {
    category: "search",
    risk: "read",
    title: "Search text",
    description: "Search the note index by content, filename or path. Chinese is matched as a substring of the note text, so a word inside a sentence is found; Latin terms go through the full-text index and are ranked by relevance. Never reads a document.",
  },
  search_frontmatter: {
    category: "search",
    risk: "read",
    title: "Search frontmatter",
    description: "Find notes by frontmatter field and value, from the index.",
  },
  link_rename_with_links: {
    category: "links",
    risk: "destructive",
    title: "Rename note and update links",
    description: "Rename a text note and update matching wikilinks across the vault.",
  },
  link_find_backlinks: {
    category: "links",
    risk: "read",
    title: "Find backlinks",
    description: "Find the notes that link to this one, from the index.",
  },
  link_get_outgoing: {
    category: "links",
    risk: "read",
    title: "Get outgoing links",
    description: "List the wikilinks a note makes, from the index, and identify the unresolved ones.",
  },
  graph_get: {
    category: "graph",
    risk: "read",
    title: "Get link graph",
    description: "Build the wikilink graph from the index: nodes, edges, and dangling-link status.",
  },
  graph_neighbors: {
    category: "graph",
    risk: "read",
    title: "Get note neighborhood",
    description: "Build a local wikilink graph around one note.",
  },
  graph_find_orphans: {
    category: "graph",
    risk: "read",
    title: "Find orphan notes",
    description: "Find isolated notes or notes without incoming or outgoing links.",
  },
  vault_list_documents: {
    category: "vault",
    risk: "read",
    title: "List vault documents",
    description: "List objects in the vault with metadata and pagination: a storage listing, including files the note index does not cover.",
  },
  vault_list_folders: {
    category: "vault",
    risk: "read",
    title: "List vault folders",
    description: "List top-level folders and their latest activity, from the index.",
  },
  vault_recent: {
    category: "vault",
    risk: "read",
    title: "List recent notes",
    description: "List recently modified text documents.",
  },
  tag_list: {
    category: "search", risk: "read", title: "List tags",
    description: "List the tags the index holds. `contains` finds a tag by a fragment of its name, for when the full name is not remembered.",
  },
  tag_list_documents: {
    category: "search", risk: "read", title: "List tag documents",
    description: "List the documents that carry a tag. An empty result says whether the tag does not exist or simply has no notes in the requested scope.",
  },
  vault_stats: {
    category: "vault",
    risk: "read",
    title: "Get vault stats",
    description: "Summarize counts, sizes, folders, and activity from the index.",
  },
  vault_index_refresh: {
    category: "vault",
    risk: "write",
    title: "Run a revision audit",
    description: "Start or resume a revision audit: it walks R2, diffs it against the index, and queues what the index owes. This is how the index catches up, not a search.",
  },
  vault_embedding_probe: {
    category: "vault",
    risk: "read",
    title: "Probe the embedding model",
    description: "Measure the deployed embedding model's real vector width, so a Vectorize index is created at the right size.",
  },
  search_semantic: {
    category: "search",
    risk: "read",
    title: "Semantic search",
    description: "Search notes by meaning, using the vector index. Complements full-text search rather than replacing it, and is eventually consistent: a note written seconds ago is found by search_text before it is found here.",
  },
};

function annotationsFor(risk: ToolRisk, title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: risk === "read",
    destructiveHint: risk === "destructive",
    idempotentHint: risk === "read",
    openWorldHint: false,
  };
}

/** A Zod schema, as opposed to a record of them. */
function isZodSchema(value: unknown): boolean {
  return !!value && typeof value === "object" && typeof (value as { safeParse?: unknown }).safeParse === "function";
}

/**
 * Tells the two accepted forms of the third argument apart.
 *
 * A config carries an `inputSchema` that is a *shape* — a plain record of schemas — while the shorthand
 * form is a shape itself, with no `inputSchema` key. The distinction is structural rather than inferred
 * from sibling keys, because inferring it that way silently misfiled `{ inputSchema: { ... } }` as a
 * shape, and the failure surfaced at registration time as "expected a Zod schema", on every call.
 */
function isToolConfig<Args extends ToolShape>(value: Args | ToolCompatConfig<Args>): value is ToolCompatConfig<Args> {
  return !!value && "inputSchema" in value && !isZodSchema((value as { inputSchema: unknown }).inputSchema);
}

/** Exported for its own test: which of the two forms was passed decides how the tool is registered. */
export function resolveToolConfig<Args extends ToolShape>(
  name: string,
  inputSchemaOrConfig: Args | ToolCompatConfig<Args>
): ToolCompatConfig<Args> {
  const supplied = isToolConfig(inputSchemaOrConfig)
    ? inputSchemaOrConfig
    : { inputSchema: inputSchemaOrConfig as Args };
  const meta = TOOL_METADATA[name] ?? {
    category: "vault" as const,
    risk: "write" as const,
    title: name,
    description: `Run ${name}.`,
  };

  return {
    ...supplied,
    title: supplied.title ?? meta.title,
    description: supplied.description ?? meta.description,
    annotations: {
      ...annotationsFor(meta.risk, supplied.title ?? meta.title),
      ...supplied.annotations,
    },
    _meta: {
      category: meta.category,
      risk: meta.risk,
      ...(supplied._meta ?? {}),
    },
  };
}

type ToolCompatCallback<Args extends ToolShape> = (
  args: z.output<z.ZodObject<Args>>
) => CallToolResult | Promise<CallToolResult>;

/**
 * The one thing a removed parameter still has to do.
 *
 * `readMode` is gone from every tool definition. A client that cached an older definition may still send
 * it, and the two values mean different things now:
 *
 * - `"index"` named the only behaviour that was ever correct, so it is accepted and ignored;
 * - `"live"` named a full R2 scan of the vault, which no longer exists as an answer. Silently answering
 *   it from the index would be a *different answer to the question that was asked*, so it is refused by
 *   name — and it must never be allowed to start a scan.
 *
 * The parameter is not in any tool's schema, so a client reading the definitions cannot discover it. It
 * survives validation only because the registration schema passes unknown keys through, which is exactly
 * what makes refusing it by name possible.
 */
const REMOVED_READ_MODE = {
  error: "live_mode_removed",
  detail: "检索不再有模式选择：索引是唯一的检索路径，R2 只用于读取具体文件的内容。",
  remedies: [
    "直接调用同一个工具，不要传 readMode：它现在固定走索引",
    "要读某篇笔记的原文用 doc_read；要按语义检索用 search_semantic",
    "索引落后于 R2 时用 vault_index_refresh 触发审计与回填，而不是让检索去扫描 R2",
  ],
};

function legacyReadModeRejection(args: Record<string, unknown>): CallToolResult | null {
  if (args.readMode !== "live") return null;
  return { content: [{ type: "text", text: JSON.stringify(REMOVED_READ_MODE, null, 2) }], isError: true };
}

export function registerToolCompat<Args extends ToolShape>(
  server: McpServer,
  name: string,
  inputSchema: Args,
  cb: ToolCompatCallback<Args>
): RegisteredTool;
export function registerToolCompat<Args extends ToolShape>(
  server: McpServer,
  name: string,
  config: ToolCompatConfig<Args>,
  cb: ToolCompatCallback<Args>
): RegisteredTool;
export function registerToolCompat<Args extends ToolShape>(
  server: McpServer,
  name: string,
  inputSchemaOrConfig: Args | ToolCompatConfig<Args>,
  cb: ToolCompatCallback<Args>
): RegisteredTool {
  const config = resolveToolConfig(name, inputSchemaOrConfig);
  return server.registerTool(name, {
    ...config,
    // `passthrough()` keeps a parameter that is no longer declared: it is refused by name rather than
    // silently stripped, and it is still absent from the schema the tool publishes.
    inputSchema: z.object(config.inputSchema).passthrough(),
    outputSchema: config.outputSchema ? z.object(config.outputSchema) : undefined,
  }, args => legacyReadModeRejection(args as Record<string, unknown>) ?? cb(args as never));
}

export function registerResourceCompat(
  server: McpServer,
  name: string,
  uri: string,
  config: ResourceMetadata,
  readCallback: ReadResourceCallback
): RegisteredResource;
export function registerResourceCompat(
  server: McpServer,
  name: string,
  template: ResourceTemplate,
  readCallback: ReadResourceTemplateCallback
): RegisteredResourceTemplate;
export function registerResourceCompat(
  server: McpServer,
  name: string,
  template: ResourceTemplate,
  config: ResourceMetadata,
  readCallback: ReadResourceTemplateCallback
): RegisteredResourceTemplate;
export function registerResourceCompat(
  server: McpServer,
  name: string,
  uriOrTemplate: string | ResourceTemplate,
  configOrReadCallback: ResourceMetadata | ReadResourceCallback | ReadResourceTemplateCallback,
  maybeReadCallback?: ReadResourceCallback | ReadResourceTemplateCallback
): RegisteredResource | RegisteredResourceTemplate {
  if (typeof uriOrTemplate === "string") {
    return server.registerResource(
      name,
      uriOrTemplate,
      configOrReadCallback as ResourceMetadata,
      maybeReadCallback as ReadResourceCallback
    );
  }
  if (maybeReadCallback) {
    return server.registerResource(
      name,
      uriOrTemplate,
      configOrReadCallback as ResourceMetadata,
      maybeReadCallback as ReadResourceTemplateCallback
    );
  }
  return server.registerResource(
    name,
    uriOrTemplate,
    {},
    configOrReadCallback as ReadResourceTemplateCallback
  );
}
