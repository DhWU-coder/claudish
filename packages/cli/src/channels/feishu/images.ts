import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SaveFeishuImageInput {
  cwd: string;
  conversationKey: string;
  messageId: string;
  imageKey: string;
  buffer: Buffer | Uint8Array;
  contentType: string;
}

export interface SavedFeishuImage {
  path: string;
  contentType: string;
}

export function saveFeishuImage(input: SaveFeishuImageInput): SavedFeishuImage {
  const extension = inferFeishuImageExtension(input.contentType);
  const safeConversation = safePathPart(input.conversationKey);
  const safeMessage = safePathPart(input.messageId);
  const safeImage = safePathPart(input.imageKey);
  const baseDir = resolve(input.cwd, ".claudish", "feishu-images");
  const imagePath = resolve(
    join(baseDir, safeConversation, `${safeMessage}-${safeImage}.${extension}`)
  );

  if (!imagePath.startsWith(`${baseDir}/`)) {
    throw new Error("Invalid Feishu image path");
  }

  mkdirSync(dirname(imagePath), { recursive: true, mode: 0o700 });
  writeFileSync(imagePath, input.buffer, { mode: 0o600 });

  return {
    path: imagePath,
    contentType: input.contentType,
  };
}

export function inferFeishuImageExtension(contentType: string): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  throw new Error(`Unsupported Feishu image content type: ${contentType}`);
}

function safePathPart(value: string): string {
  const safe = value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");
  return safe || "unknown";
}
