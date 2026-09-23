import type { ParsedDocument } from "../index/parse";
import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS, VECTOR_SCHEMA } from "./schema";
import { sha256Base64Url } from "./sha256";

/** A chunk as the chunker produces it: text and structure, with no identity yet. */
export type ChunkDraft = {
  ordinal: number;
  heading: string;
  text: string;
};

/**
 * One embeddable piece of a document, identified.
 *
 * `chunkId` is a **content-addressed physical identity**: it is a digest of the canonical identity
 * (document, content hash, chunker, model, vector schema version, ordinal), not a readable string. Two
 * consequences, both deliberate: a new revision's chunks can never collide with the old ones, so a slow
 * worker cannot overwrite a published revision; and changing the chunker or the model produces a
 * different id space rather than silently reusing ids whose vectors came from a different function.
 */
export type Chunk = ChunkDraft & {
  chunkId: string;
  contentSha256: string;
};

/** Everything a chunk id depends on. All of it is known before the publish transaction opens. */
export type ChunkIdentity = {
  documentId: number;
  contentSha256: string;
  chunkerVersion?: number;
  embeddingModel?: string;
  vectorVersion?: number;
};

/** Canonical, length-prefixed so no combination of field values can collide with another. */
export function canonicalChunkIdentity(input: {
  documentId: number;
  contentSha256: string;
  chunkerVersion: number;
  embeddingModel: string;
  vectorVersion: number;
  ordinal: number;
}): string {
  const segment = (value: string) => `${value.length}:${value}`;
  return [
    "mineral-vector-chunk-v1",
    segment(String(input.documentId)),
    segment(input.contentSha256),
    segment(String(input.chunkerVersion)),
    segment(input.embeddingModel),
    segment(String(input.vectorVersion)),
    segment(String(input.ordinal)),
  ].join("|");
}

/**
 * The id of one chunk, as an awaited digest.
 *
 * It is deliberately asynchronous and deliberately called **before** the transaction: the transaction
 * is synchronous, so an id it writes has to exist already. That ordering is what keeps the identity
 * derivation out of the critical section, and out of the runtime's synchronous-hash problem.
 */
export async function chunkIdFor(input: ChunkIdentity & { ordinal: number }): Promise<string> {
  const digest = await sha256Base64Url(canonicalChunkIdentity({
    documentId: input.documentId,
    contentSha256: input.contentSha256,
    chunkerVersion: input.chunkerVersion ?? VECTOR_SCHEMA.chunkerVersion,
    embeddingModel: input.embeddingModel ?? VECTOR_SCHEMA.model,
    vectorVersion: input.vectorVersion ?? VECTOR_SCHEMA.version,
    ordinal: input.ordinal,
  }));
  // 32 base64url characters is 192 bits: far past any collision concern, and short enough for Vectorize.
  return digest.slice(0, 32);
}

/** A heading and the text that belongs to it, before size-based splitting. */
type Section = { heading: string; body: string };

/**
 * Splits a parsed document into heading-scoped sections.
 *
 * Headings are the author's own structure, so they beat an arbitrary character count: a chunk that
 * covers one section is a coherent unit of meaning, and the heading becomes useful embedding context.
 */
function sectionsOf(parsed: ParsedDocument): Section[] {
  const lines = parsed.body.split(/\r?\n/);
  const sections: Section[] = [{ heading: parsed.title, body: "" }];
  let fence: string | null = null;
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      fence = fence === marker ? null : fence ?? marker;
    }
    const headingMatch = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      sections.push({ heading: headingMatch[2]!.trim(), body: "" });
      continue;
    }
    sections[sections.length - 1]!.body += `${line}\n`;
  }
  return sections.filter(section => section.body.trim().length > 0 || sections.length === 1);
}

/** Splits an over-long section on paragraph boundaries, then hard-splits what is still too long. */
function paragraphsOf(text: string): string[] {
  const blocks = text.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const block of blocks.length ? blocks : [text.trim()]) {
    if (block.length <= CHUNK_MAX_CHARS) {
      pieces.push(block);
      continue;
    }
    for (let offset = 0; offset < block.length; offset += CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS) {
      pieces.push(block.slice(offset, offset + CHUNK_MAX_CHARS));
    }
  }
  return pieces;
}

/** Groups paragraphs into chunks near the target size, carrying a little overlap for context. */
function groupParagraphs(paragraphs: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > CHUNK_TARGET_CHARS && current) {
      chunks.push(current);
      // The overlap is the tail of the previous chunk, so a sentence split across a boundary is still
      // represented in one of the two embeddings.
      current = `${current.slice(-CHUNK_OVERLAP_CHARS)}\n\n${paragraph}`.slice(0, CHUNK_MAX_CHARS);
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/**
 * The embedding input for one chunk.
 *
 * Title, heading and tags are structured context the author already wrote, so the model sees a labelled
 * passage rather than anonymous prose. The body is the frontmatter-stripped text: the raw YAML block is
 * never embedded, because it holds URLs and credentials that have no business in a similarity space.
 */
export function embeddingText(parsed: ParsedDocument, chunk: { heading: string; text: string }): string {
  const tags = parsed.tags.map(tag => tag.tag);
  return [
    `Title: ${parsed.title}`,
    `Heading: ${chunk.heading}`,
    ...(tags.length ? [`Tags: ${[...new Set(tags)].join(", ")}`] : []),
    "",
    chunk.text.trim(),
  ].join("\n");
}

/**
 * Chunks one document, structurally.
 *
 * It depends on the text only, so the same document always produces the same drafts: the identity that
 * makes them addressable is added afterwards, from the content hash rather than from when the work ran.
 */
export function chunkDocument(parsed: ParsedDocument): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  let ordinal = 0;
  for (const section of sectionsOf(parsed)) {
    for (const piece of groupParagraphs(paragraphsOf(section.body))) {
      if (!piece.trim()) continue;
      chunks.push({ ordinal, heading: section.heading, text: piece.trim() });
      ordinal++;
    }
  }
  // A document with no body still deserves one chunk, so its title is searchable.
  if (chunks.length === 0) chunks.push({ ordinal: 0, heading: parsed.title, text: parsed.title.trim() });
  return chunks;
}

/**
 * Turns drafts into identified chunks, before the transaction and before embedding.
 *
 * One awaited digest per chunk. Doing it here rather than inside the write means the ids are already
 * fixed when the transaction opens, so nothing inside it has to hash anything.
 */
export async function assignChunkIds(drafts: ChunkDraft[], identity: ChunkIdentity): Promise<Chunk[]> {
  return Promise.all(drafts.map(async draft => ({
    ...draft,
    contentSha256: identity.contentSha256,
    chunkId: await chunkIdFor({ ...identity, ordinal: draft.ordinal }),
  })));
}

