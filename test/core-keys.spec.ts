import { describe, expect, it } from "vitest";
import { stripDocumentExtension, validateDocumentKey } from "../packages/core/src/keys";

describe("core document keys", () => {
  it("preserves the established document identifier rules", () => {
    expect(validateDocumentKey("notes/plan.md")).toBeNull();
    expect(validateDocumentKey("../private.md")).toBe("key cannot contain '..'");
    expect(validateDocumentKey("notes//plan.md")).toBe("key cannot contain consecutive //");
    expect(stripDocumentExtension("notes/plan.markdown")).toBe("notes/plan");
  });
});
