import type { ParsedDocument } from "../index/parse";
import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS, VECTOR_SCHEMA } from "./schema";
import { sha256Base64Url } from "./sha256";

/**
 * One embeddable piece of a document.
 *
 * `chunkId` is a **content-addressed physical identity**: it is a digest of the canonical identity
 * (document, content hash, chunker, model, vector schema version, ordinal), not a readable string. Two
 * consequences, both deliberate: a new revision's chunks can never collide with the old ones, so a slow
 * worker cannot overwrite a published revision; and changing the chunker or the model produces a
 * different id space rather than silently reusing ids whose vectors came from a different function.
 */
export type Chunk = {
  ordinal: number;
  heading: string;
  text: string;
  chunkId: string;
  contentSha256: string;
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

export function chunkIdFor(input: {
  documentId: number;
  contentSha256: string;
  chunkerVersion?: number;
  embeddingModel?: string;
  vectorVersion?: number;
  ordinal: number;
}): string {
  const digest = sha256Base64Url(canonicalChunkIdentity({
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
 * Chunks one document. The same input always produces the same chunks, because the chunk id depends on
 * the content hash rather than on when the work ran.
 */
export function chunkDocument(parsed: ParsedDocument, options: { documentId: number; contentSha256: string }): Chunk[] {
  const chunks: Chunk[] = [];
  let ordinal = 0;
  for (const section of sectionsOf(parsed)) {
    for (const piece of groupParagraphs(paragraphsOf(section.body))) {
      if (!piece.trim()) continue;
      chunks.push({
        ordinal,
        heading: section.heading,
        text: piece.trim(),
        contentSha256: options.contentSha256,
        chunkId: chunkIdFor({ documentId: options.documentId, contentSha256: options.contentSha256, ordinal }),
      });
      ordinal++;
    }
  }
  // A document with no body still deserves one chunk, so its title is searchable.
  if (chunks.length === 0) {
    const text = parsed.title.trim();
    chunks.push({ ordinal: 0, heading: parsed.title, text, contentSha256: options.contentSha256, chunkId: chunkIdFor({ documentId: options.documentId, contentSha256: options.contentSha256, ordinal: 0 }) });
  }
  return chunks;
}

