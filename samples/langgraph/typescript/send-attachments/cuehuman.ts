/**
 * The CueHuman calls this sample needs: upload a file, create a request with attachments, read
 * it, and check a webhook's signature.
 *
 * Reads CUEHUMAN_API_KEY, CUEHUMAN_WEBHOOK_NAME and CUEHUMAN_WEBHOOK_SECRET from the environment.
 */

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const API_URL = process.env.CUEHUMAN_API_URL ?? "https://api.cuehuman.ai";

/** The parts of a CueHuman request this sample reads. */
export interface CueHumanRequest {
  request_id: string;
  status: string;
  result: { choice?: string } | null;
  comment: string | null;
}

export class CueHumanError extends Error {
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`${status} ${code}: ${message}`);
    this.code = code;
  }
}

async function call<T = CueHumanRequest>(method: string, route: string, body?: unknown): Promise<T> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3 && !response; attempt++) {
    try {
      response = await fetch(`${API_URL}${route}`, {
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

/** An attachment on a request: an uploaded file by its ID, or a link. */
export type Attachment = { name: string; description?: string } & ({ id: string } | { url: string });

/** Uploads a file for one request, and returns the attachment ID to name when you create it. */
export async function uploadAttachment(filePath: string, contentType: string): Promise<string> {
  const data = await readFile(filePath);
  const described = { name: path.basename(filePath), content_type: contentType, size_bytes: data.length };
  const presigned = await call<{ uploads: Array<{ id: string; upload_url: string }> }>("POST", "/v1/assets/presign-upload", {
    purpose: "request_attachment",
    files: [described],
  });
  const upload = presigned.uploads[0];
  // The file goes straight to storage: the same Content-Type, and no Authorization header.
  const response = await fetch(upload.upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: data });
  if (!response.ok) throw new Error(`Could not upload ${described.name}: HTTP ${response.status}`);
  return upload.id;
}

/**
 * Asks one human to pick one of the options, with files and links to look at first.
 *
 * Safe to call again with the same externalTaskId.
 */
export async function createRequest(ask: {
  externalTaskId: string;
  email: string;
  prompt: string;
  options: string[];
  attachments: Attachment[];
}): Promise<CueHumanRequest> {
  const body: Record<string, unknown> = {
    external_task_id: ask.externalTaskId,
    human: { email: ask.email },
    type: "decision",
    prompt: ask.prompt,
    schema: { options: ask.options },
    allow_comment: true,
    attachments: ask.attachments, // Up to 10: uploaded files by `id`, and links by `url`.
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
