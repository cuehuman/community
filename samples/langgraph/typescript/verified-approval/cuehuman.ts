/**
 * The CueHuman calls this sample needs: create a verified request, read it, check its signed
 * receipt, and check a webhook's signature.
 *
 * Reads CUEHUMAN_API_KEY, CUEHUMAN_WEBHOOK_NAME and CUEHUMAN_WEBHOOK_SECRET from the environment.
 */

import crypto from "node:crypto";

const API_URL = process.env.CUEHUMAN_API_URL ?? "https://api.cuehuman.ai";

/** The parts of a CueHuman request this sample reads. The receipt covers more of them. */
export interface CueHumanRequest extends Record<string, unknown> {
  request_id: string;
  status: string;
  result: { choice?: string } | null;
  comment: string | null;
  verification: {
    status: string;
    method: string | null;
    verified_contact: { id: string; channel: string; value: string } | null;
    verified_at: string | null;
    facts: unknown;
  } | null;
  receipt: { hash: string; signature: string; key_id: string } | null;
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
}): Promise<CueHumanRequest> {
  const body: Record<string, unknown> = {
    external_task_id: ask.externalTaskId,
    human: { email: ask.email },
    type: "decision",
    prompt: ask.prompt,
    schema: { options: ask.options },
    allow_comment: true,
    verify_human: true, // The human must enter a code sent to their address before they can answer.
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

const RECEIPT_KEYS = [
  "request_id", "organization_id", "agent_id", "external_task_id", "type", "prompt",
  "schema", "result", "comment", "submitted_at", "verify_human",
]; // prettier-ignore

/** Checks CueHuman's signed receipt: that the answer you hold is the answer CueHuman recorded. */
export async function verifyReceipt(request: CueHumanRequest): Promise<boolean> {
  const { receipt, verification } = request;
  if (!receipt) return false; // Not answered yet, or its content was deleted.

  // The receipt covers these 15 values, exactly as the request returns them.
  const signed: Record<string, unknown> = Object.fromEntries(RECEIPT_KEYS.map((key) => [key, request[key]]));
  signed.verification_method = verification?.method ?? null;
  signed.verified_contact = verification?.verified_contact ?? null;
  signed.verified_at = verification?.verified_at ?? null;
  signed.verification_facts = verification?.facts ?? null;
  const hash = crypto.createHash("sha256").update(canonicalize(signed), "utf8").digest("hex");
  if (hash !== receipt.hash) return false;

  // The signature is Ed25519 over the hash, made with the key the receipt names.
  const jwks = await fetch(`${API_URL}/.well-known/jwks.json`, { signal: AbortSignal.timeout(30_000) });
  const { keys } = (await jwks.json()) as { keys: Array<crypto.webcrypto.JsonWebKey & { kid: string }> };
  const jwk = keys.find((key) => key.kid === receipt.key_id);
  if (!jwk) return false;
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return crypto.verify(null, Buffer.from(receipt.hash, "utf8"), publicKey, Buffer.from(receipt.signature, "base64url"));
}

/** Canonical JSON (RFC 8785) for the values a receipt holds: sorted keys, no spaces. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
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
