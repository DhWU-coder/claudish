import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { enhanceFeishuImageForVision, saveFeishuImage } from "./images.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "claudish-feishu-images-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("Feishu image cache", () => {
  test("saves png image under cwd local cache", () => {
    const result = saveFeishuImage({
      cwd,
      conversationKey: "group:oc_1",
      messageId: "om_1",
      imageKey: "img_1",
      buffer: Buffer.from("png-data"),
      contentType: "image/png",
    });

    expect(result.path).toBe(
      join(cwd, ".claudish", "feishu-images", "group_oc_1", "om_1-img_1.png")
    );
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf-8")).toBe("png-data");
  });

  test("sanitizes path parts", () => {
    const result = saveFeishuImage({
      cwd,
      conversationKey: "../dm:ou_1",
      messageId: "../om_1",
      imageKey: "../img_1",
      buffer: Buffer.from("jpg-data"),
      contentType: "image/jpeg",
    });

    expect(result.path.startsWith(cwd)).toBe(true);
    expect(basename(result.path)).toBe("om_1-img_1.jpg");
  });

  test("rejects unsupported image content type", () => {
    expect(() =>
      saveFeishuImage({
        cwd,
        conversationKey: "dm:ou_1",
        messageId: "om_1",
        imageKey: "img_1",
        buffer: Buffer.from("bad"),
        contentType: "text/plain",
      })
    ).toThrow("Unsupported Feishu image content type");
  });

  test("enhances small jpeg images for vision input", async () => {
    const result = await enhanceFeishuImageForVision(
      { path: join(cwd, "small.jpg"), contentType: "image/jpeg" },
      {
        isAvailable: () => true,
        readDimensions: async () => ({ width: 892, height: 900 }),
        resizeImage: async (input) => {
          expect(input.width).toBe(1784);
          expect(input.height).toBe(1800);
        },
      }
    );

    expect(result).toEqual({
      path: join(cwd, "small.vision.png"),
      contentType: "image/png",
    });
  });

  test("keeps large images unchanged", async () => {
    const result = await enhanceFeishuImageForVision(
      { path: join(cwd, "large.png"), contentType: "image/png" },
      {
        isAvailable: () => true,
        readDimensions: async () => ({ width: 1800, height: 1200 }),
        resizeImage: async () => {
          throw new Error("should not resize");
        },
      }
    );

    expect(result).toEqual({ path: join(cwd, "large.png"), contentType: "image/png" });
  });

  test("falls back to original image when enhancer is unavailable", async () => {
    const result = await enhanceFeishuImageForVision(
      { path: join(cwd, "small.jpg"), contentType: "image/jpeg" },
      {
        isAvailable: () => false,
        readDimensions: async () => ({ width: 892, height: 900 }),
        resizeImage: async () => {
          throw new Error("should not resize");
        },
      }
    );

    expect(result).toEqual({ path: join(cwd, "small.jpg"), contentType: "image/jpeg" });
  });
});
