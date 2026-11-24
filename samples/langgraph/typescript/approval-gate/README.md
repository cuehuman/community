# An approval gate: a tool that cannot run until a person approves the call

An agent with a refund tool. LangChain stops the agent every time the model tries to call that tool, CueHuman asks a person to approve that exact call, and the tool runs only on Approve.

The model does not decide whether to ask. You name the tools that need approval, and LangChain's human-in-the-loop middleware enforces it. For a tool the model calls by choice, see the [ask-and-wait tool](../ask-and-wait-tool/).

This page first shows the code you add to your own agent, then how to run the complete example in this folder.

## How it works

Your app has two parts here: the agent run, and one web endpoint that receives CueHuman's webhooks. CueHuman reaches the human and collects the answer.

```mermaid
sequenceDiagram
    box Your app
        participant Run as Agent run
        participant Endpoint as Webhook endpoint
    end
    participant CueHuman
    participant Human

    Note over Run: 1. The model calls issue_refund and LangChain pauses the run first
    Run->>CueHuman: 2. Create a request that describes the call
    CueHuman->>Human: 3. Email with a link to the request form
    Human->>CueHuman: 4. Approve or Reject and an optional comment
    CueHuman->>Endpoint: 5. Webhook request.human_submitted
    Endpoint->>CueHuman: 6. Read the request to get the answer
    Endpoint->>Run: 7. Resume the run with the decision
    Note over Run: 8. On Approve the tool runs, on Reject the model is told why
```

A request that expires or is canceled resumes the run as a rejection, so the tool does not run.

## Add it to your agent

There are three pieces: the middleware that names the tools, a function that asks a person about each paused call, and a webhook endpoint that resumes the run.

### 1. Name the tools that need approval

From `agent.ts`:

```typescript
export const agent = createAgent({
  model: process.env.MODEL!,
  tools: [issueRefund],
  systemPrompt: "You handle billing problems. Refund an order when the customer is owed the money.",
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: { issue_refund: { allowedDecisions: ["approve", "reject"], description: describeRefund } },
      interruptMode: "per_call", // One pause, and one question, for each call.
    }),
  ],
  // A SQLite checkpointer, so a paused run survives a restart. Use Postgres in production.
  checkpointer: SqliteSaver.fromConnString("checkpoints.sqlite"),
});
```

- **`interruptOn` lists the gated tools.** Every other tool runs as usual.
- **`per_call` pauses once for each call.** If the model asks for two refunds in one turn, each gets its own request and its own answer.
- **The agent needs a checkpointer,** because the pause saves the run.

The `description` is what the person reads. From `agent.ts`:

```typescript
/** What the approver reads: the exact call the agent wants to make. */
function describeRefund(toolCall: { args: Record<string, any> }): string {
  const { amount_usd, order_id } = toolCall.args;
  return `An AI agent wants to refund ${usd(amount_usd)} on order ${order_id}. Do you approve?`;
}
```

Write it from the call's arguments, so the person approves exactly what will run.

### 2. Ask a person about each paused call

From `agent.ts`:

```typescript
/** Runs the agent until it finishes or pauses, then asks a person about each paused call. */
export async function advance(agentInput: Parameters<typeof agent.invoke>[0], threadId: string) {
  const result = await agent.invoke(agentInput, { configurable: { thread_id: threadId } });
  await askAboutPausedCalls(threadId);
  return result;
}

/** Creates one CueHuman request for each tool call the run is paused on. Safe to call again. */
export async function askAboutPausedCalls(threadId: string): Promise<void> {
  for (const paused of await pausedCalls(threadId)) {
    await createRequest({
      externalTaskId: `${threadId}:${paused.id}`, // How the webhook finds the run and the call.
      email: process.env.APPROVER_EMAIL!,
      prompt: paused.value.description,
      options: [APPROVE, REJECT],
    });
  }
}
```

- **Call `advance` wherever you would call `agent.invoke`:** when you start a run, and when you resume one. A resumed run can pause again on a later call, and `advance` asks about that one too.
- **The `external_task_id` holds the thread ID and the pause's ID.** The webhook carries it back, so your endpoint knows which run to resume and which call the answer is for. A repeated create with the same value returns the same request, and the person is not asked twice.

### 3. Resume the run from your webhook endpoint

From `webhook-server.ts`:

```typescript
async function resumeRun(event: WebhookEvent): Promise<void> {
  const separator = event.external_task_id.indexOf(":");
  const threadId = event.external_task_id.slice(0, separator);
  const pausedId = event.external_task_id.slice(separator + 1);

  // Resume only a run that is paused on this call. A repeated or late event finds none.
  if (!(await pausedCalls(threadId)).some((paused) => paused.id === pausedId)) {
    console.log(`Ignored ${event.event} for ${event.request_id}: no run is paused on it`);
    return;
  }

  // The event says what happened, not what the human answered. Read the request for that.
  const request = await getRequest(event.request_id);
  let decision: { type: "approve" } | { type: "reject"; message: string };
  if (request.result?.choice === APPROVE) {
    decision = { type: "approve" };
  } else if (request.status === "completed") {
    decision = { type: "reject", message: request.comment ?? "The approver rejected this call." };
  } else {
    decision = { type: "reject", message: `Nobody answered: the request ${request.status}. Do not try again.` };
  }

  const result = await advance(new Command({ resume: { [pausedId]: decision } }), threadId);
  if ((await pausedCalls(threadId)).length > 0) {
    console.log(`Resumed ${threadId} with ${decision.type}; it is now waiting on another call`);
  } else {
    console.log(`Resumed ${threadId} with ${decision.type} -> ${result.messages.at(-1)?.text}`);
  }
}
```

- **The answer becomes a decision.** Approve lets the tool run. Reject stops it, and the person's comment goes to the model as the reason. An expiry or a cancel is a rejection too.
- **Read the request for the answer.** The event says what happened to which request. It does not carry the person's choice.
- **Resume only a run that is paused on that call.** CueHuman can deliver an event more than once. The second time, no run is paused on it, and nothing happens.

The route that receives the webhook checks the `X-CueHuman-Signature` header before anything else, as in [pause and resume](../pause-and-resume/). This endpoint is part of your own app: in the example it runs as a separate process from the script that starts the run, and in your app it would be one route in the service that runs your agent.

## Run the complete example

| File | What it does |
|---|---|
| `agent.ts` | The agent, the middleware, and `advance` |
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

Then fill in the rest of `.env`: the approver's address, and a model with its provider's key. To use another provider, install its LangChain package and change `MODEL`.

CueHuman must be able to reach the endpoint over HTTPS. On your own machine, use a tunnel such as `cloudflared` or `ngrok` and give the profile the tunnel's address.

### Run it

Start the webhook endpoint:

```bash
npm run webhook
```

In a second terminal, start a run:

```bash
npm run start-run -- "Customer 8841 was double charged \$1,250.00 on order 1042. Please fix it."
```

```
Thread: refund-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
Paused, waiting for a person: An AI agent wants to refund $1,250.00 on order 1042. Do you approve?
```

Open the email and answer. The endpoint logs the resume:

```
Resumed refund-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed with approve -> I refunded $1,250.00 on order 1042 for customer 8841, which covers the duplicate charge.
```

Check a run at any time:

```bash
npm run show-run -- refund-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

## Before production

- Use a Postgres checkpointer in place of SQLite.
- Replace `issue_refund` with the real action.
- Resume one run at a time. If two answers for the same run can arrive together, queue them.
- Switch to a `cue_live_` key to reach people outside your organization.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. Each run then appears in LangSmith as one trace that ends at the pause, and one more for each resume.
