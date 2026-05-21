import { ensureUtf8ContentType, isTextFile, textContentTypeForKey, encodeUtf8 } from "../storage/content";
import { scanTextFiles } from "../storage/r2";
import type { Env } from "../types";
import { extractTags } from "../utils/markdown";
import { buildMatcher, snippetAt } from "../utils/search";
import { relativeTime } from "../utils/time";
import { buildDailyNoteKey, getDailyNotesDir } from "../utils/daily";
import { buildGraph } from "../mcp/graph-data";
import { backupTextObject, moveObject, stripTextExt, trashKey, wikilinkReplacement } from "../mcp/shared";
import { backlinkTargets } from "../storage/r2";
import {
  clearSessionCookie,
  createSessionCookie,
  isAuthenticated,
  passwordConfigured,
  unauthorized,
} from "../auth/session";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function isSystemKey(key: string): boolean {
  return key.startsWith(".history/") || key.startsWith(".trash/");
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

function notFound(message = "Not found"): Response {
  return Response.json({ error: message }, { status: 404, headers: JSON_HEADERS });
}

function decodeKey(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function listTextObjects(bucket: R2Bucket, prefix?: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const result = await bucket.list({ prefix, cursor, limit: 1000, include: ["httpMetadata"] });
    objects.push(...result.objects.filter(object => isTextFile(object.key) && !isSystemKey(object.key)));
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return objects;
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  return Response.json({
    authenticated: await isAuthenticated(request, env),
    passwordConfigured: passwordConfigured(env),
  }, { headers: JSON_HEADERS });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!passwordConfigured(env)) {
    return Response.json({ error: "ADMIN_PASSWORD is not configured" }, { status: 503, headers: JSON_HEADERS });
  }
  const body = await readJson<{ password?: string }>(request);
  if (!body.password || body.password !== env.ADMIN_PASSWORD) {
    return Response.json({ error: "Invalid password" }, { status: 401, headers: JSON_HEADERS });
  }
  return Response.json(
    { ok: true },
    { headers: { ...JSON_HEADERS, "Set-Cookie": await createSessionCookie(env, request) } }
  );
}

function handleLogout(): Response {
  return Response.json(
    { ok: true },
    { headers: { ...JSON_HEADERS, "Set-Cookie": clearSessionCookie() } }
  );
}

async function handleDocuments(url: URL, env: Env): Promise<Response> {
  const prefix = url.searchParams.get("prefix") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
  const objects = (await listTextObjects(env.BEDROCK, prefix))
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    .slice(0, limit)
    .map(object => ({
      key: object.key,
      title: (object.key.split("/").pop() ?? object.key).replace(/\.[^.]+$/, ""),
      folder: object.key.includes("/") ? object.key.slice(0, object.key.lastIndexOf("/") + 1) : "",
      size: object.size,
      modified: object.uploaded.toISOString(),
      modifiedRelative: relativeTime(object.uploaded),
      contentType: ensureUtf8ContentType(object.httpMetadata?.contentType ?? textContentTypeForKey(object.key)),
    }));
  return Response.json({ count: objects.length, items: objects }, { headers: JSON_HEADERS });
}

async function handleDocumentGet(url: URL, env: Env): Promise<Response> {
  const key = decodeKey(url.searchParams.get("key"));
  if (!key) return badRequest("Missing key");
  if (!isTextFile(key)) return badRequest("Only text documents can be edited");
  const object = await env.BEDROCK.get(key);
  if (!object) return notFound();
  return Response.json({
    key,
    content: await object.text(),
    modified: object.uploaded.toISOString(),
    etag: object.httpEtag,
    size: object.size,
    contentType: ensureUtf8ContentType(object.httpMetadata?.contentType ?? textContentTypeForKey(key)),
  }, { headers: JSON_HEADERS });
}

async function handleDocumentPut(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ key?: string; content?: string; baseEtag?: string; baseModified?: string; force?: boolean }>(request);
  if (!body.key?.trim()) return badRequest("Missing key");
  if (body.key.includes("..") || body.key.startsWith("/") || body.key.endsWith("/")) return badRequest("Invalid key");
  if (!isTextFile(body.key)) return badRequest("Only text documents can be saved");
  const content = body.content ?? "";
  const current = await env.BEDROCK.get(body.key);
  if (current) {
    const etagChanged = body.baseEtag && current.httpEtag !== body.baseEtag;
    const modifiedChanged = body.baseModified && current.uploaded.toISOString() !== body.baseModified;
    if (!body.force && (etagChanged || modifiedChanged)) {
      return Response.json({
        error: "Document changed on the server",
        conflict: true,
        current: {
          key: body.key,
          content: await current.text(),
          modified: current.uploaded.toISOString(),
          etag: current.httpEtag,
          size: current.size,
        },
      }, { status: 409, headers: JSON_HEADERS });
    }
    await backupTextObject(env.BEDROCK, body.key, await current.text(), current.httpMetadata?.contentType);
  }
  await env.BEDROCK.put(body.key, encodeUtf8(content), {
    httpMetadata: { contentType: textContentTypeForKey(body.key) },
  });
  const saved = await env.BEDROCK.get(body.key);
  return Response.json({
    ok: true,
    key: body.key,
    size: encodeUtf8(content).length,
    modified: saved?.uploaded.toISOString() ?? new Date().toISOString(),
    etag: saved?.httpEtag ?? null,
  }, { headers: JSON_HEADERS });
}

async function handleDocumentCreate(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ key?: string; content?: string }>(request);
  const key = body.key?.trim();
  if (!key) return badRequest("Missing key");
  if (key.includes("..") || key.startsWith("/") || key.endsWith("/") || key.includes("//")) return badRequest("Invalid key");
  if (!isTextFile(key)) return badRequest("Only text documents can be created");

  const existing = await env.BEDROCK.get(key);
  if (existing) return Response.json({ error: "Document already exists" }, { status: 409, headers: JSON_HEADERS });

  const content = body.content ?? "";
  await env.BEDROCK.put(key, encodeUtf8(content), {
    httpMetadata: { contentType: textContentTypeForKey(key) },
  });
  const created = await env.BEDROCK.get(key);
  return Response.json({
    ok: true,
    key,
    content,
    modified: created?.uploaded.toISOString() ?? new Date().toISOString(),
    etag: created?.httpEtag ?? null,
    size: encodeUtf8(content).length,
  }, { headers: JSON_HEADERS });
}

async function handleDaily(request: Request, env: Env): Promise<Response> {
  const body = request.method === "POST"
    ? await readJson<{ date?: string; folder?: string }>(request)
    : {};
  const date = body.date || new Date().toISOString().slice(0, 10);
  const folder = getDailyNotesDir(env, body.folder);
  const key = buildDailyNoteKey(date, folder);
  const existing = await env.BEDROCK.get(key);
  if (existing) {
    return Response.json({ key, created: false, content: await existing.text() }, { headers: JSON_HEADERS });
  }
  const content = `# ${date}\n\n`;
  await env.BEDROCK.put(key, encodeUtf8(content), {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
  return Response.json({ key, created: true, content }, { headers: JSON_HEADERS });
}

async function handleSearch(url: URL, env: Env): Promise<Response> {
  const query = url.searchParams.get("q")?.trim();
  if (!query) return Response.json({ query: "", count: 0, items: [] }, { headers: JSON_HEADERS });
  const matcher = buildMatcher(query, false, false);
  if ("error" in matcher) return badRequest(matcher.error);

  const items = await scanTextFiles(env.BEDROCK, undefined, (key, text, object) => {
    if (isSystemKey(key)) return null;
    const basename = key.split("/").pop() ?? key;
    const nameHit = matcher.match(basename) || matcher.match(key);
    const textHit = matcher.match(text);
    if (!nameHit && !textHit) return null;
    const hit = textHit || nameHit;
    return {
      key,
      modified: object.uploaded.toISOString(),
      modifiedRelative: relativeTime(object.uploaded),
      snippet: hit ? snippetAt(text, hit.index, hit.length, 80) : "",
    };
  }, { max: 100 });
  items.sort((a, b) => b.modified.localeCompare(a.modified));
  return Response.json({ query, count: items.length, items }, { headers: JSON_HEADERS });
}

async function handleTags(env: Env): Promise<Response> {
  const counter = new Map<string, number>();
  await scanTextFiles(env.BEDROCK, undefined, (key, text) => {
    if (isSystemKey(key)) return null;
    for (const tag of extractTags(text)) counter.set(tag, (counter.get(tag) ?? 0) + 1);
    return null;
  });
  const tags = [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
  return Response.json({ totalUnique: tags.length, tags }, { headers: JSON_HEADERS });
}

async function handleFolders(env: Env): Promise<Response> {
  const folders = new Map<string, { count: number; lastModified: Date }>();
  for (const object of await listTextObjects(env.BEDROCK)) {
    const parts = object.key.split("/");
    const folder = parts.length > 1 ? `${parts[0]}/` : "(root)";
    const current = folders.get(folder);
    if (current) {
      current.count++;
      if (object.uploaded > current.lastModified) current.lastModified = object.uploaded;
    } else {
      folders.set(folder, { count: 1, lastModified: object.uploaded });
    }
  }
  return Response.json({
    folders: [...folders.entries()].map(([folder, value]) => ({
      folder,
      count: value.count,
      lastModified: value.lastModified.toISOString(),
      lastModifiedRelative: relativeTime(value.lastModified),
    })).sort((a, b) => b.lastModified.localeCompare(a.lastModified)),
  }, { headers: JSON_HEADERS });
}

async function handleGraph(env: Env): Promise<Response> {
  return Response.json(await buildGraph(env.BEDROCK, { includeDangling: true, limit: 1000 }), { headers: JSON_HEADERS });
}

async function handleDocumentHistory(url: URL, env: Env): Promise<Response> {
  const key = decodeKey(url.searchParams.get("key"));
  if (!key) return badRequest("Missing key");
  const suffix = `/${key}`;
  const items: Array<{ backupKey: string; createdAt: string | null; size: number; modified: string; modifiedRelative: string }> = [];
  let cursor: string | undefined;
  do {
    const result = await env.BEDROCK.list({
      prefix: ".history/",
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    });
    for (const object of result.objects) {
      if (!object.key.endsWith(suffix)) continue;
      items.push({
        backupKey: object.key,
        createdAt: object.customMetadata?.createdAt ?? null,
        size: object.size,
        modified: object.uploaded.toISOString(),
        modifiedRelative: relativeTime(object.uploaded),
      });
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  items.sort((a, b) => b.modified.localeCompare(a.modified));
  return Response.json({ key, items: items.slice(0, 50) }, { headers: JSON_HEADERS });
}

async function handleDocumentRestore(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ key?: string; backupKey?: string }>(request);
  if (!body.key || !body.backupKey) return badRequest("Missing key or backupKey");
  if (!isTextFile(body.key)) return badRequest("Only text documents can be restored");
  if (!body.backupKey.startsWith(".history/") || body.backupKey.includes("..")) return badRequest("Invalid backupKey");

  const backup = await env.BEDROCK.get(body.backupKey);
  if (!backup) return notFound("Backup not found");
  const current = await env.BEDROCK.get(body.key);
  if (current) {
    await backupTextObject(env.BEDROCK, body.key, await current.text(), current.httpMetadata?.contentType);
  }
  const content = await backup.text();
  await env.BEDROCK.put(body.key, encodeUtf8(content), {
    httpMetadata: { contentType: textContentTypeForKey(body.key, backup.httpMetadata?.contentType) },
  });
  const restored = await env.BEDROCK.get(body.key);
  return Response.json({
    ok: true,
    key: body.key,
    content,
    modified: restored?.uploaded.toISOString() ?? new Date().toISOString(),
    etag: restored?.httpEtag ?? null,
    size: encodeUtf8(content).length,
  }, { headers: JSON_HEADERS });
}

async function handleDocumentRename(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ from?: string; to?: string; overwrite?: boolean; updateLinks?: boolean }>(request);
  const from = body.from?.trim();
  const to = body.to?.trim();
  if (!from || !to) return badRequest("Missing from or to");
  if (from === to) return badRequest("from and to are the same");
  if (!isTextFile(from) || !isTextFile(to)) return badRequest("Only text documents can be renamed here");
  if (from.includes("..") || to.includes("..") || from.startsWith("/") || to.startsWith("/") || from.endsWith("/") || to.endsWith("/")) {
    return badRequest("Invalid key");
  }

  const src = await env.BEDROCK.get(from);
  if (!src) return notFound("Source not found");
  const target = await env.BEDROCK.get(to);
  if (target && !body.overwrite) return Response.json({ error: "Target already exists" }, { status: 409, headers: JSON_HEADERS });

  const srcText = await src.text();
  await backupTextObject(env.BEDROCK, from, srcText, src.httpMetadata?.contentType);
  if (target) await backupTextObject(env.BEDROCK, to, await target.text(), target.httpMetadata?.contentType);

  await env.BEDROCK.put(to, encodeUtf8(srcText), {
    httpMetadata: { contentType: textContentTypeForKey(to, src.httpMetadata?.contentType) },
    customMetadata: src.customMetadata,
  });
  await env.BEDROCK.delete(from);

  const updated: Array<{ key: string; backupKey: string }> = [];
  if (body.updateLinks !== false) {
    const targets = backlinkTargets(from);
    const replacement = stripTextExt(to);
    const linkUpdates = await scanTextFiles(env.BEDROCK, undefined, (key, text, object) => {
      if (key === from || key === to || isSystemKey(key)) return null;
      const replaced = wikilinkReplacement(text, targets, replacement);
      return replaced.changed ? { key, text, next: replaced.text, contentType: object.httpMetadata?.contentType } : null;
    });

    for (const item of linkUpdates) {
      const backupKey = await backupTextObject(env.BEDROCK, item.key, item.text, item.contentType);
      await env.BEDROCK.put(item.key, encodeUtf8(item.next), {
        httpMetadata: { contentType: textContentTypeForKey(item.key, item.contentType) },
      });
      updated.push({ key: item.key, backupKey });
    }
  }

  const renamed = await env.BEDROCK.get(to);
  return Response.json({
    ok: true,
    from,
    to,
    updatedLinks: updated,
    key: to,
    content: srcText,
    modified: renamed?.uploaded.toISOString() ?? new Date().toISOString(),
    etag: renamed?.httpEtag ?? null,
    size: encodeUtf8(srcText).length,
  }, { headers: JSON_HEADERS });
}

async function handleDocumentDelete(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ key?: string; permanent?: boolean }>(request);
  const key = body.key?.trim();
  if (!key) return badRequest("Missing key");
  if (key.includes("..") || key.startsWith("/") || key.endsWith("/")) return badRequest("Invalid key");
  const existing = await env.BEDROCK.get(key);
  if (!existing) return notFound();

  if (body.permanent) {
    await env.BEDROCK.delete(key);
    return Response.json({ ok: true, key, action: "deleted", permanent: true }, { headers: JSON_HEADERS });
  }

  const target = trashKey(key);
  await moveObject(env.BEDROCK, key, target);
  return Response.json({ ok: true, key, action: "trashed", trashKey: target }, { headers: JSON_HEADERS });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/session") return handleSession(request, env);
  if (request.method === "POST" && path === "/api/auth/login") return handleLogin(request, env);
  if (request.method === "POST" && path === "/api/auth/logout") return handleLogout();

  if (!await isAuthenticated(request, env)) return unauthorized();

  try {
    if (request.method === "GET" && path === "/api/documents") return handleDocuments(url, env);
    if (request.method === "GET" && path === "/api/document") return handleDocumentGet(url, env);
    if (request.method === "PUT" && path === "/api/document") return handleDocumentPut(request, env);
    if (request.method === "POST" && path === "/api/document/create") return handleDocumentCreate(request, env);
    if (request.method === "GET" && path === "/api/document/history") return handleDocumentHistory(url, env);
    if (request.method === "POST" && path === "/api/document/restore") return handleDocumentRestore(request, env);
    if (request.method === "POST" && path === "/api/document/rename") return handleDocumentRename(request, env);
    if (request.method === "POST" && path === "/api/document/delete") return handleDocumentDelete(request, env);
    if (path === "/api/daily" && (request.method === "GET" || request.method === "POST")) return handleDaily(request, env);
    if (request.method === "GET" && path === "/api/search") return handleSearch(url, env);
    if (request.method === "GET" && path === "/api/tags") return handleTags(env);
    if (request.method === "GET" && path === "/api/folders") return handleFolders(env);
    if (request.method === "GET" && path === "/api/graph") return handleGraph(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    return Response.json({ error: message }, { status: 500, headers: JSON_HEADERS });
  }

  return notFound();
}
