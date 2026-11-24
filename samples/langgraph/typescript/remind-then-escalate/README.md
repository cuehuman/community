# An approval that does not wait forever: remind, then escalate

An approval step that handles silence. If the approver does not answer in time, the graph reminds them once. If they still do not answer, it asks a backup approver. If nobody answers, it stops without acting.

It builds on [pause and resume](../pause-and-resume/), and uses the same webhook endpoint. This page first shows the code you add to your own graph, then how to run the complete example in this folder.

## How it works

1. The graph asks the approver and pauses. Each request has a time limit, one day unless you change it.
2. An answer resumes the run: Approve carries out the action, and Reject stops it.
3. If the request expires, CueHuman sends `request.expired` and the run resumes with no answer. The graph then **reminds** the approver, by sending the expired request again, and pauses again.
4. If the reminder expires too, the graph **escalates**: it asks the backup approver, with a new request, and pauses again.
5. If the backup does not answer either, the run stops and nothing is done.

## Add it to your graph

### 1. Decide the next step from what the run resumed with

From `graph.ts`:

```typescript
function route(state: State): "carry_out" | "stop" | "remind" | "escalate" {
  const answer = state.answer!;
  if (answer.choice === APPROVE) return "carry_out";
  if (answer.choice === REJECT || answer.status !== "expired") return "stop";
  // Nobody answered in time. Remind the approver once, then ask the backup once.
  return ({ first: "remind", reminder: "escalate", backup: "stop" } as const)[state.stage!];
}
```

The webhook endpoint resumes the run with the request's status and the human's choice. A choice ends the wait. An expiry moves to the next stage, and each stage is tried once.

### 2. Remind the approver

From `graph.ts`:

```typescript
/** Sends the expired request to the same approver again. CueHuman calls this a reissue. */
async function remind(state: State, config: RunnableConfig) {
  const request = await reissueRequest(state.requestId!, {
    externalTaskId: `${config.configurable!.thread_id}:reminder`,
    expiresInSeconds: ANSWER_WITHIN,
  });
  return { requestId: request.request_id, stage: "reminder" as const };
}
```

CueHuman calls this a reissue: a new request, with a new link and a new time limit, made from the expired one and sent to the same person. From `cuehuman.ts`:

```typescript
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
```

- **Only an expired request can be reissued,** and only once. The reminder is a request of its own, so it can expire and be acted on in turn.
- **A nudge is the other kind of reminder.** `POST /v1/requests/{id}/nudge` reminds the person about a request that is still open, no sooner than 24 hours after it was created.

### 3. Ask the backup approver

From `graph.ts`:

```typescript
/** Asks the backup approver, with a new request. */
async function escalate(state: State, config: RunnableConfig) {
  const request = await createRequest({
    externalTaskId: `${config.configurable!.thread_id}:backup`,
    email: state.backupEmail,
    prompt: `An AI agent wants to: ${state.action}. The first approver did not answer. Do you approve?`,
    options: [APPROVE, REJECT],
    expiresInSeconds: ANSWER_WITHIN,
  });
  return { requestId: request.request_id, stage: "backup" as const };
}
```

A reissue cannot go to a different person, so the backup gets a new request.

- **Every stage has its own task ID,** made of the thread ID and the stage's name. The webhook endpoint takes the thread ID from the part before the colon, so one endpoint serves all three requests.
- **Each of these steps is its own node.** When a run resumes, LangGraph runs the paused node again from its first line, so a create or a reissue in the same node as `interrupt()` would run twice.

The webhook endpoint itself is the one from [pause and resume](../pause-and-resume/): it checks the `X-CueHuman-Signature` header, then resumes the run. It is part of your own app.

## Run the complete example

| File | What it does |
|---|---|
| `graph.ts` | The graph: ask, wait, then carry out, stop, remind or escalate |
| `webhook-server.ts` | The webhook endpoint that resumes the waiting run |
| `cuehuman.ts` | The CueHuman calls: create a request, reissue it, read it, check a webhook's signature |
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

To watch every stage in a few minutes, set `ANSWER_WITHIN_SECONDS=60` in `.env`.

### Run it

Start the webhook endpoint:

```bash
npm run webhook
```

In a second terminal, start a run. With a test key, both addresses must belong to members of your organization.

```bash
npm run start-run -- "Refund order 1042 for \$1,250.00" approver@example.com backup@example.com
```

Answer the first email, or leave it. The endpoint logs each step:

```
Resumed approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.expired -> now waiting at the reminder request
Resumed approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.expired -> now waiting at the backup request
Resumed approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Approved by the backup approver. Carried out: Refund order 1042 for $1,250.00
```

Check a run at any time:

```bash
npm run show-run -- approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

## Before production

- Use a Postgres checkpointer in place of SQLite.
- Replace `carryOut` with the real action.
- Switch to a `cue_live_` key to reach people outside your organization.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. Each run then appears in LangSmith as one trace that ends at the pause, and one more for each resume.
