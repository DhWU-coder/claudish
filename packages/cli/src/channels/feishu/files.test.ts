import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { saveFeishuFile } from "./files.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "claudish-feishu-files-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("Feishu file cache", () => {
  test("saves uploaded files directly under cwd feishu-files", () => {
    const result = saveFeishuFile({
      cwd,
      messageId: "om_1",
      fileKey: "file_1",
      fileName: "报告.pdf",
      buffer: Buffer.from("pdf-data"),
      contentType: "application/pdf",
    });

    expect(result.path).toBe(join(cwd, "feishu-files", "om_1-file_1-报告.pdf"));
    expect(result.contentType).toBe("application/pdf");
    expect(result.fileName).toBe("报告.pdf");
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf-8")).toBe("pdf-data");
  });

  test("sanitizes uploaded file names and keeps writes inside cwd", () => {
    const result = saveFeishuFile({
      cwd,
      messageId: "../om_1",
      fileKey: "../file_1",
      fileName: "../secrets/需求 说明.docx",
      buffer: Buffer.from("docx-data"),
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(result.path.startsWith(join(cwd, "feishu-files"))).toBe(true);
    expect(basename(result.path)).toBe("om_1-file_1-需求_说明.docx");
  });

  test("uses a stable fallback name when Feishu omits the file name", () => {
    const result = saveFeishuFile({
      cwd,
      messageId: "om_1",
      fileKey: "file_1",
      buffer: Buffer.from("file-data"),
      contentType: "application/octet-stream",
    });

    expect(result.path).toBe(join(cwd, "feishu-files", "om_1-file_1-file_1"));
    expect(result.fileName).toBe("file_1");
  });
});
