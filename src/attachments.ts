import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { T3Client } from "./client.ts";
import { T3Error } from "./client.ts";
import { IMAGE_MIME_BY_EXTENSION, type Attachment, type UploadUrlResult } from "./contracts.ts";

const MAX_ATTACHMENTS = 8;

export async function attachmentsFromPaths(client: T3Client, paths: string[]): Promise<Attachment[]> {
  if (paths.length > MAX_ATTACHMENTS) throw new T3Error(`at most ${MAX_ATTACHMENTS} attachments per message`, 64);
  const attachments: Attachment[] = [];
  for (const path of paths) {
    const bytes = await readFile(path);
    const name = basename(path);
    const imageMime = IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()];
    if (imageMime) {
      attachments.push({ type: "image", name, mimeType: imageMime, sizeBytes: bytes.byteLength, dataUrl: `data:${imageMime};base64,${bytes.toString("base64")}` });
      continue;
    }
    const mimeType = "application/octet-stream";
    const minted = (await client.rpc("attachments.createUploadUrl", { type: "file", name, mimeType, sizeBytes: bytes.byteLength })) as UploadUrlResult;
    await client.uploadBytes(minted.relativeUrl, mimeType, bytes);
    attachments.push({ type: "file", id: minted.attachmentId, name, mimeType, sizeBytes: bytes.byteLength });
  }
  return attachments;
}

export async function readPrompt(promptFile: string | undefined): Promise<string> {
  if (promptFile) return readFile(promptFile, "utf8");
  if (process.stdin.isTTY) throw new T3Error("pass the prompt on stdin or with --prompt-file", 64);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) throw new T3Error("prompt is empty", 64);
  return text;
}
