/**
 * The CueHuman calls this sample needs: create a request, read it, and check a webhook's signature.
 *
 * Reads CUEHUMAN_API_KEY, CUEHUMAN_WEBHOOK_NAME and CUEHUMAN_WEBHOOK_SECRET from the environment.
 */

import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API_URL = process.env.CUEHUMAN_API_URL ?? "https://api.cuehuman.ai";

/** A file the human uploaded. The download link works for 15 minutes from the read that returned it. */
export interface UploadedFile {
  id: string;
  name: string;
  category: string | null;
  size_bytes: number;
  download_url: string;
}

/** The parts of a CueHuman request this sample reads. */
export interface CueHumanRequest {
  request_id: string;
  status: string;
  result: { files?: UploadedFile[] } | null;
  comment: string | null;
}

export class CueHumanError extends Error {
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`${status} ${code}: ${message}`);
    this.code = code;
  }
}

async function call(method: string, path: string, body?: unknown): Promise<CueHumanRequest> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3 && !response; attempt++) {
    try {
      response = await fetch(`${API_URL}${path}`, {
        method,
        headers: { Authorization: `Bearer ${process.env.CUEHUMAN_API_KEY}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // A dropped or timed-out connection. Both calls are safe to repeat.
      if (attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }
  if (response!.ok) return response!.json();
  const error = await response!.json().catch(() => ({}));
  throw new CueHumanError(response!.status, error.code ?? "unknown", error.error ?? response!.statusText);
}

/** Asks one human to upload files. Safe to call again with the same externalTaskId. */
export async function createFileRequest(ask: {
  externalTaskId: string;
  email: string;
  prompt: string;
  categories: string[];
}): Promise<CueHumanRequest> {
  const body: Record<string, unknown> = {
    external_task_id: ask.externalTaskId,
    human: { email: ask.email },
    type: "file",
    prompt: ask.prompt,
    schema: {
      content_types: ["application/pdf", "image/jpeg", "image/png"],
      categories: ask.categories, // The human labels each file with one of these.
      max_files: 3,
    },
    webhook_name: process.env.CUEHUMAN_WEBHOOK_NAME, // The profile that points at your endpoint.
  };
  if (process.env.CUEHUMAN_EXPIRES_IN_SECONDS) {
    body.expires_in_seconds = Number(process.env.CUEHUMAN_EXPIRES_IN_SECONDS); // When not set, 10 days.
  }
  try {
    return await call("POST", "/v1/requests", body);
  } catch (err) {
    // The request for this task has already ended: read it instead of creating another.
    if (!(err instanceof CueHumanError) || err.code !== "external_task_id_conflict") throw err;
    return getRequest(ask.externalTaskId);
  }
}

/** Reads a request by its request ID or by your external_task_id. */
export function getRequest(requestId: string): Promise<CueHumanRequest> {
  return call("GET", `/v1/requests/${encodeURIComponent(requestId)}`);
}

/**
 * Saves the files the human uploaded, and returns where each one was saved.
 *
 * A download link works for 15 minutes from the read that returned it, so the request is
 * read here, just before the downloads, and the links are never stored.
 */
export async function downloadFiles(requestId: string, folder: string): Promise<string[]> {
  const request = await getRequest(requestId);
  await mkdir(folder, { recursive: true });
  const saved: string[] = [];
  for (const file of request.result?.files ?? []) {
    // The file ID keeps names apart, and basename keeps the human's file name inside the folder.
    const savedAt = path.join(folder, `${file.id}-${path.basename(file.name)}`);
    const response = await fetch(file.download_url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Could not download ${file.name}: HTTP ${response.status}`);
    await writeFile(savedAt, Buffer.from(await response.arrayBuffer()));
    saved.push(savedAt);
  }
  return saved;
}

/** Checks the X-CueHuman-Signature header, `t=<unix seconds>,v1=<signature>`, against the raw body. */
export function verifyWebhook(rawBody: unknown, signatureHeader: string, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(signatureHeader.split(",").map((part) => part.split("=")));
  const timestamp = Number(parts.t);
  if (!Buffer.isBuffer(rawBody) || !parts.v1 || !Number.isInteger(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = crypto
    .createHmac("sha256", process.env.CUEHUMAN_WEBHOOK_SECRET!)
    .update(`${parts.t}.`)
    .update(rawBody)
    .digest();
  const received = Buffer.from(parts.v1, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
