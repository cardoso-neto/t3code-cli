import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { RpcInput, T3Client } from "./client.ts";
import { UsageError } from "./errors.ts";

type Attachment = Extract<RpcInput<"orchestration.dispatchCommand">, { type: "message.dispatch" }>["attachments"][number];
type ImageUpload = Exclude<RpcInput<"attachments.createUploadUrl">, { type: "file" }>;

const IMAGE_MIME_BY_EXTENSION: Record<string, ImageUpload["mimeType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Uploads each file and returns references the next message claims. Limits are the server's to enforce. */
export async function attachmentsFromPaths(client: T3Client, paths: string[]): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const path of paths) {
    const bytes = await readFile(path);
    const name = basename(path);
    const sizeBytes = bytes.byteLength;
    const imageMime = IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()];
    const reference = imageMime ? { type: "image" as const, name, mimeType: imageMime, sizeBytes } : { type: "file" as const, name, mimeType: "application/octet-stream", sizeBytes };
    const upload = await client.call("attachments.createUploadUrl", reference);
    await client.http("POST", upload.relativeUrl, { bytes, mimeType: reference.mimeType });
    attachments.push({ ...reference, id: upload.attachmentId });
  }
  return attachments;
}

export async function readPrompt(promptFile: string | undefined): Promise<string> {
  if (promptFile) return readFile(promptFile, "utf8");
  if (process.stdin.isTTY) throw new UsageError("pass the prompt on stdin or with --prompt-file");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) throw new UsageError("prompt is empty");
  return text;
}
