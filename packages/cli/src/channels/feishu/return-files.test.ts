import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFeishuReturnFileDirectives } from "./return-files.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "claudish-feishu-return-files-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("Feishu return files", () => {
  test("extracts a cwd-local file path from an otherwise normal model reply", () => {
    const filePath = join(cwd, "2026年金价整理.xlsx");
    writeFileSync(filePath, "xlsx-data");

    const result = extractFeishuReturnFileDirectives(
      ["已整理好 Excel 文件：", "```text", filePath, "```", "内容包括：", "- 月度汇总"].join("\n"),
      cwd
    );

    expect(result.filePaths).toEqual([filePath]);
    expect(result.text).toBe("已整理好 Excel 文件：\n内容包括：\n- 月度汇总");
  });
});
