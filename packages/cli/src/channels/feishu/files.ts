import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface SaveFeishuFileInput {
  cwd: string;
  messageId: string;
  fileKey: string;
  fileName?: string;
  buffer: Buffer | Uint8Array;
  contentType: string;
}

export interface SavedFeishuFile {
  path: string;
  contentType: string;
  fileName: string;
}

export function saveFeishuFile(input: SaveFeishuFileInput): SavedFeishuFile {
  const safeMessage = safePathPart(input.messageId);
  const safeFileKey = safePathPart(input.fileKey);
  const fileName = safeFileName(input.fileName || input.fileKey || "file");
  const baseDir = resolve(input.cwd, "feishu-files");
  const filePath = resolve(join(baseDir, `${safeMessage}-${safeFileKey}-${fileName}`));

  if (!filePath.startsWith(`${baseDir}${sep}`)) {
    throw new Error("Invalid Feishu file path");
  }

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, input.buffer, { mode: 0o600 });

  return {
    path: filePath,
    contentType: input.contentType,
    fileName,
  };
}

function safePathPart(value: string): string {
  const safe = value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");
  return safe || "unknown";
}

function safeFileName(value: string): string {
  const safe = value
    .split(/[\\/]+/g)
    .filter(Boolean)
    .pop()
    ?.replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");
  return safe || "file";
}
