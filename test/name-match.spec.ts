import { describe, expect, it } from "vitest";
import { MATCH_TIER, matchSignals, nameMatchQuality } from "../apps/mcp/src/mcp/name-match";

/**
 * A filename match is a navigation signal, and it is graded.
 *
 * The distinction that matters is "the note is called this" versus "these characters occur somewhere in
 * its path": the first should be able to outrank a phrase found in a paragraph, the second should not be
 * lifted above the full-text ranking at all.
 */
describe("grading a filename match", () => {
  it("recognises a note the caller all but named", () => {
    expect(nameMatchQuality("daily/2026-06-18.md", "2026-06-18")).toBe("exact");
    expect(nameMatchQuality("index.md", "index")).toBe("exact");
    // The extension is not part of the name a caller types, but typing it is not an error either.
    expect(nameMatchQuality("index.md", "index.md")).toBe("exact");
  });

  it("treats a date fragment as a prefix, which is the case that motivated this", () => {
    expect(nameMatchQuality("daily/2026-06-18.md", "2026-06")).toBe("prefix");
    expect(nameMatchQuality("travel/徒步麦理浩径第一天.md", "徒步麦理浩径")).toBe("prefix");
  });

  it("separates a substring of the name from a substring of the path", () => {
    expect(nameMatchQuality("daily/2026-06-18.md", "06-18")).toBe("substring");
    expect(nameMatchQuality("daily/2026-06-18.md", "daily")).toBe("path");
    expect(nameMatchQuality("workflow/records/运动/2026-06-跑步月报.md", "records")).toBe("path");
  });

  it("reports no match rather than inventing one", () => {
    // `filename-search` matched the key, so this can only happen if the two disagree about what a
    // substring is — and a caller is better served by knowing that than by a fabricated grade.
    expect(nameMatchQuality("daily/a.md", "zzz")).toBeNull();
    expect(nameMatchQuality("daily/a.md", "   ")).toBeNull();
  });

  it("does not care about case, because nobody types a filename exactly", () => {
    expect(nameMatchQuality("notes/Mineral-Plan.md", "mineral-plan")).toBe("exact");
    expect(nameMatchQuality("notes/Mineral-Plan.md", "MINERAL")).toBe("prefix");
  });
});

describe("where a name match sits relative to a content match", () => {
  it("puts a strong name match above content and a weak one below", () => {
    expect(MATCH_TIER.name.exact).toBeLessThan(MATCH_TIER.content);
    expect(MATCH_TIER.name.prefix).toBeLessThan(MATCH_TIER.content);
    expect(MATCH_TIER.name.substring).toBeGreaterThan(MATCH_TIER.content);
    expect(MATCH_TIER.name.path).toBeGreaterThan(MATCH_TIER.content);
  });

  it("keeps both signals on one document, strongest first", () => {
    // A document that carries both must come back once and must say both, or the merge has thrown away
    // the reason the caller can trust the hit.
    expect(matchSignals({ name: "prefix", content: true })).toEqual({ tier: MATCH_TIER.name.prefix, matched: ["name", "content"] });
    expect(matchSignals({ name: "substring", content: true })).toEqual({ tier: MATCH_TIER.content, matched: ["content", "name"] });
    expect(matchSignals({ name: "exact", content: false })).toEqual({ tier: MATCH_TIER.name.exact, matched: ["name"] });
    expect(matchSignals({ name: null, content: true })).toEqual({ tier: MATCH_TIER.content, matched: ["content"] });
  });
});
