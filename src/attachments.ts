import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ChatImageAttachment } from "@t3tools/contracts";
import type { Command, T3Client } from "./client.ts";
import { UsageError } from "./errors.ts";

type Attachment = Extract<Command, { type: "thread.turn.start" }>["message"]["attachments"][number];

const IMAGE_MIME_BY_EXTENSION: Record<string, ChatImageAttachment["mimeType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Images go inline as data URLs; other files are uploaded first and referenced by id. Limits are the server's to enforce. */
export async function attachmentsFromPaths(client: T3Client, paths: string[]): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const path of paths) {
    const bytes = await readFile(path);
    const name = basename(path);
    const sizeBytes = bytes.byteLength;
    const imageMime = IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()];
    if (imageMime) {
      attachments.push({ type: "image", name, mimeType: imageMime, sizeBytes, dataUrl: `data:${imageMime};base64,${bytes.toString("base64")}` });
      continue;
    }
    const mimeType = "application/octet-stream";
    const upload = await client.call("attachments.createUploadUrl", { type: "file", name, mimeType, sizeBytes });
    await client.http("POST", upload.relativeUrl, { bytes, mimeType });
    attachments.push({ type: "file", id: upload.attachmentId, name, mimeType, sizeBytes });
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
