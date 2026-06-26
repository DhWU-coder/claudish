import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

export const MAX_FEISHU_RETURN_FILE_BYTES = 30 * 1024 * 1024;

export interface FeishuReturnFile {
  path: string;
  fileName: string;
}

export interface ExtractFeishuReturnFileResult {
  text: string;
  filePaths: string[];
}

export function extractFeishuReturnFileDirectives(
  text: string,
  cwd?: string
): ExtractFeishuReturnFileResult {
  const filePaths: string[] = [];
  const visibleLines: string[] = [];
  let codeFence: { lines: string[]; removedFilePath: boolean } | undefined;

  for (const line of String(text || "").split(/\r?\n/)) {
    if (isCodeFenceLine(line)) {
      if (codeFence) {
        codeFence.lines.push(line);
        flushCodeFence();
      } else {
        codeFence = { lines: [line], removedFilePath: false };
      }
      continue;
    }

    const extractedLine = extractReturnFileLine(line, cwd);
    filePaths.push(...extractedLine.filePaths);

    if (codeFence) {
      codeFence.removedFilePath ||= extractedLine.removedFilePath;
      if (extractedLine.visibleText) {
        codeFence.lines.push(extractedLine.visibleText);
      }
      continue;
    }

    if (extractedLine.visibleText || !extractedLine.removedFilePath) {
      visibleLines.push(extractedLine.visibleText);
    }
  }

  flushCodeFence();

  return {
    text: visibleLines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    filePaths: Array.from(new Set(filePaths)),
  };

  function flushCodeFence(): void {
    if (!codeFence) return;
    const hasClosingFence =
      codeFence.lines.length > 1 && isCodeFenceLine(codeFence.lines.at(-1) ?? "");
    const innerLines = codeFence.lines.slice(1, hasClosingFence ? -1 : undefined);
    const hasVisibleInnerText = innerLines.some((item) => item.trim());
    if (codeFence.removedFilePath && !hasClosingFence) {
      visibleLines.push(...innerLines);
    } else if (!codeFence.removedFilePath || hasVisibleInnerText) {
      visibleLines.push(...codeFence.lines);
    }
    codeFence = undefined;
  }
}

export function resolveFeishuReturnFile(cwd: string, inputPath: string): FeishuReturnFile {
  const root = resolve(cwd);
  const resolvedPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const pathFromRoot = relative(root, resolvedPath);

  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("只能回传当前工作目录内的文件");
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`回传文件不存在：${inputPath}`);
  }

  const stat = statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`回传路径不是文件：${inputPath}`);
  }
  if (stat.size <= 0) {
    throw new Error(`不能回传空文件：${inputPath}`);
  }
  if (stat.size > MAX_FEISHU_RETURN_FILE_BYTES) {
    throw new Error(`回传文件超过 30MB：${inputPath}`);
  }

  return {
    path: resolvedPath,
    fileName: basename(resolvedPath),
  };
}

function extractReturnFileLine(
  line: string,
  cwd: string | undefined
): { visibleText: string; filePaths: string[]; removedFilePath: boolean } {
  const directive = line.match(/^\s*\[\[claudish:file:(.+?)\]\]\s*$/);
  if (directive) {
    const filePath = directive[1].trim();
    return {
      visibleText: "",
      filePaths: filePath ? [filePath] : [],
      removedFilePath: true,
    };
  }

  if (!cwd) {
    return {
      visibleText: line,
      filePaths: [],
      removedFilePath: false,
    };
  }

  const root = resolve(cwd);
  let cursor = 0;
  let visibleText = line;
  const filePaths: string[] = [];

  while (cursor < line.length) {
    const start = line.indexOf(root, cursor);
    if (start < 0) break;

    const match = findLongestExistingFilePath(line, start, cwd);
    if (!match) {
      cursor = start + root.length;
      continue;
    }

    filePaths.push(match.resolvedPath);
    visibleText = visibleText.replace(match.originalText, "");
    cursor = match.end;
  }

  return {
    visibleText: cleanupVisibleFileLine(visibleText),
    filePaths,
    removedFilePath: filePaths.length > 0,
  };
}

function findLongestExistingFilePath(
  line: string,
  start: number,
  cwd: string
): { originalText: string; resolvedPath: string; end: number } | null {
  for (let end = line.length; end > start; end -= 1) {
    const originalText = line.slice(start, end);
    const candidate = trimPathCandidate(originalText);
    if (!candidate) continue;

    try {
      const file = resolveFeishuReturnFile(cwd, candidate);
      return {
        originalText,
        resolvedPath: file.path,
        end,
      };
    } catch {}
  }

  return null;
}

function trimPathCandidate(text: string): string {
  return text
    .trim()
    .replace(/[`"'“”‘’)\]}>,，。；;：:、]+$/g, "")
    .trim();
}

function cleanupVisibleFileLine(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\s*/g, "```")
    .replace(/^\s*[:：-]\s*$/, "")
    .trim();
}

function isCodeFenceLine(line: string): boolean {
  return /^\s*```/.test(line);
}
