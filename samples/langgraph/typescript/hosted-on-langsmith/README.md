# An approval on a LangGraph server, such as a deployment on LangSmith

The [pause and resume](../pause-and-resume/) approval, for a graph that a LangGraph server runs: a deployment on LangSmith, or the local dev server. The server saves the runs, and the webhook endpoint is a route added to the same server.

This page first shows the code you add to your own project, then how to run the complete example in this folder.

## How it works

1. A client starts a run on the server. The graph creates the CueHuman request, with the server's thread ID as the task ID, and pauses.
2. The human answers, and CueHuman calls the server's `/webhooks/cuehuman` route.
3. The route checks the signature, reads the request for the answer, and resumes the thread through the server's own API.
4. The server continues the run, on whichever machine it has free.

## Add it to your project

### 1. Name the graph and the webhook route

`langgraph.json` tells the server what to load. `graphs` names the graph, and `http` adds your own routes beside the server's API.

```json
{
  "node_version": "20",
  "dependencies": ["."],
  "graphs": {
    "approval": "./graph.ts:graph"
  },
  "http": {
    "app": "./webhook.ts:app"
  },
  "env": ".env"
}
```

### 2. Compile the graph with no checkpointer

The nodes are the ones from pause and resume. The server saves each run, so the graph does not bring its own storage. From `graph.ts`:

```typescript
/** `langgraph.json` names this as the "approval" graph. */
export const graph = new StateGraph(State)
  .addNode("ask_human", askHuman)
  .addNode("wait_for_human", waitForHuman)
  .addNode("carry_out", carryOut)
  .addNode("stop", stop)
  .addEdge(START, "ask_human")
  .addEdge("ask_human", "wait_for_human")
  .addConditionalEdges("wait_for_human", route)
  .addEdge("carry_out", END)
  .addEdge("stop", END)
  .compile();
```

### 3. Resume the thread from the webhook route

From `webhook.ts`:

```typescript
async function resumeRun(client: Client, event: WebhookEvent): Promise<void> {
  const threadId = event.external_task_id;

  // Resume only a run that is paused on this request. A repeated or late event finds none.
  const pausedOn = (await pausedAt(client, threadId)).map((paused) => (paused.value as any)?.request_id);
  if (!pausedOn.includes(event.request_id)) {
    console.log(`Ignored ${event.event} for ${event.request_id}: no run is paused on it`);
    return;
  }

  // The event says what happened, not what the human answered. Read the request for that.
  const request = await getRequest(event.request_id);
  const answer = { status: request.status, choice: request.result?.choice ?? null, comment: request.comment };
  const result = (await client.runs.wait(threadId, ASSISTANT, { command: { resume: answer } })) as { outcome?: string };
  console.log(`Resumed ${threadId} after ${event.event} -> ${result.outcome}`);
}
```

- **The route calls the server's own API.** It uses `LANGGRAPH_URL` when that is set, or the address the webhook came in on.
- **A resume is a new run on the same thread,** with the answer as its `resume` command. The server picks the run up where it paused.
- **The task ID is the server's thread ID,** so the event leads straight to the thread. An event for anything else finds no paused run and is ignored.

### 4. Start a run from a client

From `start-run.ts`:

```typescript
const [action, approverEmail] = process.argv.slice(2);
// LANGGRAPH_URL is your deployment's address, or http://localhost:2024 for the local dev server.
const client = new Client({ apiUrl: process.env.LANGGRAPH_URL, apiKey: process.env.LANGSMITH_API_KEY });

const thread = await client.threads.create();
const result = (await client.runs.wait(thread.thread_id, "approval", { input: { action, approverEmail } })) as Record<string, unknown>;

console.log(`Thread:  ${thread.thread_id}`);
```

## Run the complete example

| File | What it does |
|---|---|
| `graph.ts` | The approval graph, compiled for a LangGraph server |
| `webhook.ts` | The webhook route added to the server |
| `cuehuman.ts` | The CueHuman calls: create a request, read it, check a webhook's signature |
| `start-run.ts` | Starts a run on the server |
| `show-run.ts` | Shows where a run is |
| `langgraph.json` | Names the graph and the webhook route for the server |

### Set up

You need Node.js 20 or later.

```bash
npm install
cp .env.example .env
```

In the CueHuman Developer Portal:

1. Create an agent and copy its test key into `CUEHUMAN_API_KEY`.
2. Create a webhook profile that points at `https://<your-server>/webhooks/cuehuman`, with signing on. Subscribe it to `request.human_submitted`, `request.expired` and `request.canceled`.
3. Put the profile's name in `CUEHUMAN_WEBHOOK_NAME` and its signing secret in `CUEHUMAN_WEBHOOK_SECRET`.

CueHuman must be able to reach the endpoint over HTTPS. On your own machine, use a tunnel such as `cloudflared` or `ngrok` and give the profile the tunnel's address.

### Run it on your machine

Start the LangGraph dev server, which listens on port 2024:

```bash
npm run dev
```

In a second terminal, start a run. With a test key, the address must belong to a member of your organization.

```bash
npm run start-run -- "Refund order 1042 for \$1,250.00" approver@example.com
```

Open the email and answer. The server logs the resume:

```
Resumed 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Approved. Carried out: Refund order 1042 for $1,250.00
```

Check a run at any time:

```bash
npm run show-run -- 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

### Deploy it to LangSmith

Deploy this folder as you would any LangGraph app, with the values from `.env` set as the deployment's environment variables. Then:

- Set `LANGGRAPH_URL` to the deployment's address, for the scripts and for the webhook route.
- Point the webhook profile at `https://<your-deployment>/webhooks/cuehuman`.
- A deployment checks an API key on the calls it receives. Add a custom header to the webhook profile, `x-api-key` with a LangSmith API key, so CueHuman's calls are let in.

This sample was tested on the local dev server. It has not been deployed to LangSmith.

## Before production

- Replace `carryOut` with the real action.
- Switch to a `cue_live_` key to reach people outside your organization.
