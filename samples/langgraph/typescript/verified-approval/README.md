# A verified approval, with proof you can keep

An approval for a high-risk action. The approver must prove they hold the address the request was sent to, and the graph checks CueHuman's signed receipt of the answer before it acts.

It builds on [pause and resume](../pause-and-resume/), and uses the same webhook endpoint. This page first shows the code you add to your own graph, then how to run the complete example in this folder.

## How it works

1. The graph creates the request with `verify_human` on, and pauses.
2. The approver opens the link. Before they see the request, CueHuman sends a six-digit code to their address and they enter it.
3. They approve or reject, and CueHuman calls your webhook with `request.human_submitted`.
4. The endpoint resumes the run. Before acting on an approval, the graph reads the request again and checks three things: the recorded answer is an approval, the approver verified, and the receipt matches the answer.
5. Only then does the action run. The verified address, the time and the receipt are kept with the run.

## Add it to your graph

### 1. Turn verification on

It is one field on the create call. From `cuehuman.ts`:

```typescript
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
```

### 2. Check the proof before acting

From `graph.ts`:

```typescript
/** Before acting on an approval, reads the request again and checks what CueHuman recorded. */
async function checkProof(state: State) {
  if (state.answer!.choice !== APPROVE) return {};
  const request = await getRequest(state.requestId!);
  const verification = request.verification;
  if (request.result?.choice !== APPROVE) return { refused: "the recorded answer is not an approval" };
  if (verification?.status !== "verified") return { refused: "the approver did not verify their address" };
  if (!(await verifyReceipt(request))) return { refused: "the receipt does not match the answer" };
  // Keep the evidence: who verified, when, and the signed receipt. Store the request too if you need it later.
  const proof = {
    verifiedAddress: verification.verified_contact!.value,
    verifiedAt: verification.verified_at!,
    receipt: request.receipt!,
  };
  return { proof };
}
```

- **`verification` says what the approver proved:** that they could read a code sent to `verified_contact`, and when.
- **The receipt says the answer was not changed.** It does not say who the person is.
- **Keep the evidence with your own records.** A receipt cannot be checked again once the request's content is deleted, by a cancel or at the end of your retention period.

### 3. Check the receipt

From `cuehuman.ts`:

```typescript
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
```

The receipt is CueHuman's signature over a hash of 15 values: the request, the answer and the verification. The check rebuilds the hash from the request you read, then verifies the signature with CueHuman's public key from `/.well-known/jwks.json`. If any of the values was changed, the hash no longer matches.

The webhook endpoint itself is the one from [pause and resume](../pause-and-resume/): it checks the `X-CueHuman-Signature` header, then resumes the run. It is part of your own app.

## Run the complete example

| File | What it does |
|---|---|
| `graph.ts` | The graph: ask with verification on, wait, check the proof, then act |
| `webhook-server.ts` | The webhook endpoint that resumes the waiting run |
| `cuehuman.ts` | The CueHuman calls: create a verified request, read it, check its receipt, check a webhook's signature |
| `start-run.ts` | Starts a run and exits while it waits |
| `show-run.ts` | Shows where a run is |

### Set up

You need Node.js 20 or later.

```bash
npm install
cp .env.example .env
```

In the CueHuman Developer Portal:

1. Create an agent and copy its test key into `CUEHUMAN_API_KEY`.
2. Create a webhook profile that points at `https://<your-host>/webhooks/cuehuman`, with signing on. Subscribe it to `request.human_submitted`, `request.expired` and `request.canceled`.
3. Put the profile's name in `CUEHUMAN_WEBHOOK_NAME` and its signing secret in `CUEHUMAN_WEBHOOK_SECRET`.

CueHuman must be able to reach the endpoint over HTTPS. On your own machine, use a tunnel such as `cloudflared` or `ngrok` and give the profile the tunnel's address.

### Run it

Start the webhook endpoint:

```bash
npm run webhook
```

In a second terminal, start a run. With a test key, the address must belong to a member of your organization.

```bash
npm run start-run -- "Wire \$25,000.00 to Example Company" approver@example.com
```

Open the email, enter the code CueHuman sends you, and approve. The endpoint logs the resume:

```
Resumed approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Approved by approver@example.com, verified at 2026-08-20T17:11:30.000Z. Carried out: Wire $25,000.00 to Example Company
```

Check a run at any time:

```bash
npm run show-run -- approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

## Before production

- Use a Postgres checkpointer in place of SQLite.
- Store the answered request with its receipt, so you can show the proof later.
- Replace `carryOut` with the real action.
- Switch to a `cue_live_` key to reach people outside your organization.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. Each run then appears in LangSmith as one trace that ends at the pause, and one more for each resume.
