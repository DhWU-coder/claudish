import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VISION_MIN_MAX_DIMENSION = 1600;
const VISION_TARGET_MAX_DIMENSION = 1800;
const VISION_MAX_SCALE = 3;

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

interface FeishuImageDimensions {
  width: number;
  height: number;
}

interface ResizeFeishuImageInput {
  sourcePath: string;
  targetPath: string;
  width: number;
  height: number;
}

interface FeishuImageVisionEnhancerOptions {
  isAvailable?: () => boolean;
  readDimensions?: (path: string) => Promise<FeishuImageDimensions | null>;
  resizeImage?: (input: ResizeFeishuImageInput) => Promise<void>;
  onError?: (error: unknown) => void;
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

export async function enhanceFeishuImageForVision(
  input: SavedFeishuImage,
  options: FeishuImageVisionEnhancerOptions = {}
): Promise<SavedFeishuImage> {
  if (!isVisionEnhanceableContentType(input.contentType)) return input;

  const isAvailable = options.isAvailable ?? defaultVisionEnhancerAvailable;
  if (!isAvailable()) return input;

  try {
    const readDimensions = options.readDimensions ?? readImageDimensionsWithSips;
    const dimensions = await readDimensions(input.path);
    const scale = dimensions ? resolveVisionEnhancementScale(dimensions) : 0;
    if (!dimensions || scale <= 1) return input;

    const targetPath = resolveVisionImagePath(input.path);
    const resizeImage = options.resizeImage ?? resizeImageWithSips;
    await resizeImage({
      sourcePath: input.path,
      targetPath,
      width: dimensions.width * scale,
      height: dimensions.height * scale,
    });

    return { path: targetPath, contentType: "image/png" };
  } catch (error) {
    options.onError?.(error);
    return input;
  }
}

export function inferFeishuImageExtension(contentType: string): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  throw new Error(`Unsupported Feishu image content type: ${contentType}`);
}

function isVisionEnhanceableContentType(contentType: string): boolean {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  return normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/jpg";
}

function defaultVisionEnhancerAvailable(): boolean {
  return process.platform === "darwin";
}

async function readImageDimensionsWithSips(path: string): Promise<FeishuImageDimensions | null> {
  const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  return parseSipsDimensions(stdout);
}

function parseSipsDimensions(output: string): FeishuImageDimensions | null {
  const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function resolveVisionEnhancementScale(dimensions: FeishuImageDimensions): number {
  const maxDimension = Math.max(dimensions.width, dimensions.height);
  if (maxDimension >= VISION_MIN_MAX_DIMENSION) return 1;
  return Math.min(VISION_MAX_SCALE, Math.ceil(VISION_TARGET_MAX_DIMENSION / maxDimension));
}

async function resizeImageWithSips(input: ResizeFeishuImageInput): Promise<void> {
  await execFileAsync("sips", [
    "-s",
    "format",
    "png",
    "-z",
    String(input.height),
    String(input.width),
    input.sourcePath,
    "--out",
    input.targetPath,
  ]);
}

function resolveVisionImagePath(imagePath: string): string {
  const extension = extname(imagePath);
  if (!extension) return `${imagePath}.vision.png`;
  return `${imagePath.slice(0, -extension.length)}.vision.png`;
}

function safePathPart(value: string): string {
  const safe = value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");
  return safe || "unknown";
}
