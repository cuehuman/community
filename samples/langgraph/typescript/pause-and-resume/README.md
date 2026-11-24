# Pause a LangGraph run for a human, and resume it by webhook

An approval step for a LangGraph workflow. The graph asks a person to approve an action, pauses, and carries on when the person answers. The wait can last days, and nothing stays running while the graph is paused.

This page first shows the code you add to your own graph, then how to run the complete example in this folder.

## How it works

Your app has two parts here: the LangGraph run, and one web endpoint that receives CueHuman's webhooks. CueHuman reaches the human and collects the answer.

```mermaid
sequenceDiagram
    box Your app
        participant Run as LangGraph run
        participant Endpoint as Webhook endpoint
    end
    participant CueHuman
    participant Human

    Run->>CueHuman: 1. Create the request (thread ID as external_task_id)
    Note over Run: 2. interrupt() saves the run and nothing stays running
    CueHuman->>Human: 3. Email with a link to the request form
    Human->>CueHuman: 4. Approve or Reject and an optional comment
    CueHuman->>Endpoint: 5. Webhook request.human_submitted
    Endpoint->>CueHuman: 6. Read the request to get the answer
    Endpoint->>Run: 7. Resume the run with the answer
    Note over Run: 8. carry_out or stop
```

A request that expires or is canceled resumes the run the same way, with no choice, and the run stops without acting.

## Add it to your graph

There are three pieces: a node that creates the request, a node that pauses, and a webhook endpoint that resumes the run.

### 1. Create the request in its own node

From `graph.ts`:

```typescript
/** Creates the CueHuman request. Its own node, so it is not repeated when the run resumes. */
async function askHuman(state: State, config: RunnableConfig) {
  const request = await createRequest({
    externalTaskId: config.configurable!.thread_id, // How the webhook finds this run.
    email: state.approverEmail,
    prompt: `An AI agent wants to: ${state.action}. Do you approve?`,
    options: [APPROVE, REJECT],
  });
  return { requestId: request.request_id };
}
```

`createRequest` is one call to `POST /v1/requests`. From `cuehuman.ts`, this is what it sends:

```typescript
  const body: Record<string, unknown> = {
    external_task_id: ask.externalTaskId,
    human: { email: ask.email },
    type: "decision",
    prompt: ask.prompt,
    schema: { options: ask.options },
    allow_comment: true,
    webhook_name: process.env.CUEHUMAN_WEBHOOK_NAME, // The profile that points at your endpoint.
  };
```

- **Keep this in its own node.** When a run resumes, LangGraph runs the paused node again from its first line. A create call in the same node as `interrupt()` would run a second time.
- **Send the thread ID as `external_task_id`.** The webhook carries it back, so your endpoint knows which run to resume. A repeated create with the same value returns the same request, and the human is not asked twice. That is why `cuehuman.ts` can safely send a call again after a dropped connection. To ask more than one question in a run, add a suffix to it.

### 2. Pause in the next node

From `graph.ts`:

```typescript
/** Pauses the run until the webhook endpoint resumes it with the human's answer. */
function waitForHuman(state: State) {
  const answer = interrupt({ request_id: state.requestId });
  return { answer };
}
```

`interrupt()` saves the run through the graph's checkpointer and stops. The value your endpoint resumes with is what `interrupt()` returns, so the next node can read `state.answer`.

### 3. Resume the run from your webhook endpoint

From `webhook-server.ts`:

```typescript
// express.raw keeps the body as the bytes CueHuman signed.
app.post("/webhooks/cuehuman", express.raw({ type: "application/json" }), (req, res) => {
  if (!verifyWebhook(req.body, req.get("X-CueHuman-Signature") ?? "")) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }
  res.json({ received: true }); // Answer first: CueHuman waits 8 seconds for the reply.
  const event: WebhookEvent = JSON.parse(req.body.toString("utf8"));
  if (RESUMING_EVENTS.has(event.event)) {
    resumeRun(event).catch((err) => console.error(`Could not resume ${event.external_task_id}:`, err));
  }
});

async function resumeRun(event: WebhookEvent): Promise<void> {
  const threadId = event.external_task_id;
  const config = { configurable: { thread_id: threadId } };

  // Resume only a run that is paused on this request. A repeated or late event finds none.
  const snapshot = await graph.getState(config);
  const pausedOn = snapshot.tasks.flatMap((task) => task.interrupts).map((paused) => paused.value?.request_id);
  if (!pausedOn.includes(event.request_id)) {
    console.log(`Ignored ${event.event} for ${event.request_id}: no run is paused on it`);
    return;
  }

  // The event says what happened, not what the human answered. Read the request for that.
  const request = await getRequest(event.request_id);
  const answer = { status: request.status, choice: request.result?.choice ?? null, comment: request.comment };
  const result = await graph.invoke(new Command({ resume: answer }), config);
  console.log(`Resumed ${threadId} after ${event.event} -> ${result.outcome}`);
}
```

- **Check the signature first.** `verifyWebhook` in `cuehuman.ts` checks the `X-CueHuman-Signature` header against the raw body, so a forged call cannot resume a run.
- **Read the request for the answer.** The event says what happened to which request. It does not carry the human's choice.
- **Resume only a run that is paused on that request.** CueHuman can deliver an event more than once. The second time, no run is paused on it, and nothing happens.
- **Handle three events:** `request.human_submitted`, `request.expired` and `request.canceled`. Otherwise a run whose request expires would wait forever.

This endpoint is part of your own app. In the example it runs as a separate process from the script that starts the run, to show that nothing has to stay running while the run waits. In your app it would be one route in the service that runs your graph.

## Run the complete example

| File | What it does |
|---|---|
| `graph.ts` | The graph: `ask_human`, `wait_for_human`, then `carry_out` or `stop` |
| `webhook-server.ts` | The webhook endpoint that resumes the waiting run |
| `cuehuman.ts` | The CueHuman calls: create a request, read it, check a webhook's signature |
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
npm run start-run -- "Refund order 1042 for \$1,250.00" you@example.com
```

```
Thread:  approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
Request: req_8fK9xL2pQ1mZb4vNt7wYs
Paused, waiting for the human.
```

Open the email and answer. The endpoint logs the resume:

```
Resumed approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Approved. Carried out: Refund order 1042 for $1,250.00
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

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. Each run then appears in LangSmith as two traces on the same thread: one that ends at the pause, and one for the resume.
