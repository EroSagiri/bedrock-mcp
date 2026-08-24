import { describe, expect, it } from "vitest";
import {
  createStaticAccessToken,
  normalizeStaticPrefix,
  readBearerToken,
  verifyStaticAccessToken,
} from "../src/auth/static-token";

describe("static access tokens", () => {
  it("authorizes matching keys until expiry", async () => {
    const issued = await createStaticAccessToken("test-secret", "attachments/", 600, 1_000);
    await expect(verifyStaticAccessToken(
      issued.token,
      "test-secret",
      "attachments/image.png",
      1_100
    )).resolves.toBe(true);
    await expect(verifyStaticAccessToken(
      issued.token,
      "test-secret",
      "private/image.png",
      1_100
    )).resolves.toBe(false);
    await expect(verifyStaticAccessToken(
      issued.token,
      "test-secret",
      "attachments/image.png",
      1_600
    )).resolves.toBe(false);
  });

  it("rejects tampering and protected system keys", async () => {
    const issued = await createStaticAccessToken("test-secret", "", 600, 1_000);
    await expect(verifyStaticAccessToken(
      `${issued.token}x`,
      "test-secret",
      "image.png",
      1_100
    )).resolves.toBe(false);
    await expect(verifyStaticAccessToken(
      issued.token,
      "test-secret",
      ".history/backup/image.png",
      1_100
    )).resolves.toBe(false);
  });

  it("normalizes prefixes and reads Bearer headers", () => {
    expect(normalizeStaticPrefix("/attachments")).toBe("attachments/");
    expect(normalizeStaticPrefix("../private")).toBeNull();
    expect(readBearerToken(new Request("https://example.com", {
      headers: { Authorization: "Bearer abc.def" },
    }))).toBe("abc.def");
  });
});
