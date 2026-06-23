import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { saveFeishuImage } from "./images.js";

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

    expect(result.path).toBe(join(cwd, ".claudish", "feishu-images", "group_oc_1", "om_1-img_1.png"));
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
});
