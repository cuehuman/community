/**
 * The CueHuman calls this sample needs: create a request, read it, and check a webhook's signature.
 *
 * Reads CUEHUMAN_API_KEY, CUEHUMAN_WEBHOOK_NAME and CUEHUMAN_WEBHOOK_SECRET from the environment.
 */

import crypto from "node:crypto";

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

/** Asks one human to pick one of the options. Safe to call again with the same externalTaskId. */
export async function createRequest(ask: {
  externalTaskId: string;
  email: string;
  prompt: string;
  options: string[];
  expiresInSeconds: number;
}): Promise<CueHumanRequest> {
  const body = {
    external_task_id: ask.externalTaskId,
    human: { email: ask.email },
    type: "decision",
    prompt: ask.prompt,
    schema: { options: ask.options },
    allow_comment: true,
    expires_in_seconds: ask.expiresInSeconds,
    webhook_name: process.env.CUEHUMAN_WEBHOOK_NAME, // The profile that points at your endpoint.
  };
  try {
    return await call("POST", "/v1/requests", body);
  } catch (err) {
    // The request for this task has already ended: read it instead of creating another.
    if (!(err instanceof CueHumanError) || err.code !== "external_task_id_conflict") throw err;
    return getRequest(ask.externalTaskId);
  }
}

/** Sends an expired request to the same human again, as a new request. Safe to call again. */
export async function reissueRequest(
  requestId: string,
  again: { externalTaskId: string; expiresInSeconds: number },
): Promise<CueHumanRequest> {
  const body = { external_task_id: again.externalTaskId, expires_in_seconds: again.expiresInSeconds };
  try {
    return await call("POST", `/v1/requests/${requestId}/reissue`, body);
  } catch (err) {
    // Already reissued: read the request the first reissue created.
    const repeat = err instanceof CueHumanError && ["request_already_reissued", "external_task_id_conflict"].includes(err.code);
    if (!repeat) throw err;
    return getRequest(again.externalTaskId);
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
