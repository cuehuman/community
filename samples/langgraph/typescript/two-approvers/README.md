# An action that needs every approver to say yes

An approval that goes to several people at once. Each approver gets their own request, each answer resumes its own branch of the graph, and the action runs only when everyone has approved.

It builds on [pause and resume](../pause-and-resume/). This page first shows the code you add to your own graph, then how to run the complete example in this folder.

## How it works

1. One node creates a request for each approver.
2. The graph then opens one branch for each approver, side by side, and every branch pauses.
3. When an approver answers, CueHuman calls your webhook. The endpoint finds the branch that is paused on that request and resumes only that branch.
4. The run stays paused until every branch has an answer: an approval, a rejection, or an expiry.
5. The last node decides. Every approver must have approved, or nothing is done.

## Add it to your graph

### 1. Create one request for each approver

From `graph.ts`:

```typescript
/** Creates one request for each approver. Its own node, so it is not repeated when the run resumes. */
async function askApprovers(state: State, config: RunnableConfig) {
  const threadId = config.configurable!.thread_id;
  const requests: Record<string, string> = {};
  for (const [index, email] of state.approverEmails.entries()) {
    const request = await createRequest({
      externalTaskId: `${threadId}:${index + 1}`, // Starts with the thread ID, so the webhook finds this run.
      email,
      prompt: `An AI agent wants to: ${state.action}. Every approver must agree. Do you approve?`,
      options: [APPROVE, REJECT],
    });
    requests[email] = request.request_id;
  }
  return { requests };
}
```

Each request's task ID is the thread ID and the approver's number, so the webhook endpoint can find the run from any of them.

### 2. Open one branch for each approver, and pause in it

From `graph.ts`:

```typescript
function oneBranchForEachApprover(state: State): Send[] {
  return Object.entries(state.requests).map(
    ([email, requestId]) => new Send("wait_for_approver", { email, requestId }),
  );
}
```

```typescript
/** Pauses this approver's branch until the webhook endpoint resumes it with their answer. */
function waitForApprover(branch: { email: string; requestId: string }) {
  const answer: Answer = interrupt({ request_id: branch.requestId });
  return { answers: { [branch.email]: answer } };
}
```

`Send` starts a copy of the node for each approver. The branches write to the same `answers` value, so the graph's state merges what they return.

### 3. Resume only the branch that was answered

From `webhook-server.ts`:

```typescript
async function resumeRun(event: WebhookEvent): Promise<void> {
  const threadId = event.external_task_id.split(":")[0];
  const config = { configurable: { thread_id: threadId } };

  // Find the branch that is paused on this request. A repeated or late event finds none.
  const paused = (await pausedBranches(threadId)).find((branch) => branch.value?.request_id === event.request_id);
  if (!paused) {
    console.log(`Ignored ${event.event} for ${event.request_id}: no run is paused on it`);
    return;
  }

  // The event says what happened, not what the human answered. Read the request for that.
  const request = await getRequest(event.request_id);
  const answer = { status: request.status, choice: request.result?.choice ?? null, comment: request.comment };
  // Resume only that branch, by the ID of its pause. The other branches keep waiting.
  const result = await graph.invoke(new Command({ resume: { [paused.id!]: answer } }), config);
  const stillWaiting = (await pausedBranches(threadId)).length;
  if (stillWaiting > 0) {
    console.log(`Resumed one branch of ${threadId} after ${event.event}; ${stillWaiting} still waiting`);
  } else {
    console.log(`Resumed ${threadId} after ${event.event} -> ${result.outcome}`);
  }
}
```

Each pause has an ID. Resuming with that ID answers one branch and leaves the others waiting. In LangGraph.js a branch that has been answered still lists its pause until the others finish, so `pausedBranches` in `graph.ts` leaves out the ones that already have a result.

### 4. Decide once everyone has answered

From `graph.ts`:

```typescript
/** Runs once every branch has an answer. The action needs a yes from every approver. */
function decide(state: State) {
  const notApproved = Object.entries(state.answers).filter(([, answer]) => answer.choice !== APPROVE);
  if (notApproved.length === 0) {
    // Replace this with the real action.
    return { outcome: `Approved by all ${Object.keys(state.answers).length} approvers. Carried out: ${state.action}` };
  }
  const reasons = notApproved.map(([email, answer]) =>
    answer.choice === REJECT ? `${email} rejected (${answer.comment ?? "no comment"})` : `${email} did not answer`,
  );
  return { outcome: `Not approved: ${reasons.join("; ")}. Nothing was done.` };
}
```

## Run the complete example

| File | What it does |
|---|---|
| `graph.ts` | The graph: ask every approver, wait in one branch each, then decide |
| `webhook-server.ts` | The webhook endpoint that resumes the branch that was answered |
| `cuehuman.ts` | The CueHuman calls: create a request, read it, check a webhook's signature |
| `start-run.ts` | Starts a run and exits while it waits |
| `show-run.ts` | Shows how many approvers have answered |

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

In a second terminal, start a run with two or more approvers. With a test key, every address must belong to a member of your organization.

```bash
npm run start-run -- "Wire \$25,000.00 to Example Company" first@example.com second@example.com
```

Answer the emails one at a time. The endpoint logs each answer:

```
Resumed one branch of approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted; 1 still waiting
Resumed approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Approved by all 2 approvers. Carried out: Wire $25,000.00 to Example Company
```

Check a run at any time:

```bash
npm run show-run -- approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

## Before production

- Use a Postgres checkpointer in place of SQLite.
- Resume one run at a time. If two answers for the same run can arrive together, queue them.
- A rejection does not end the wait for the others. To stop early, cancel the open requests when one approver rejects.
- Switch to a `cue_live_` key to reach people outside your organization.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. Each run then appears in LangSmith as one trace that ends at the pause, and one more for each resume.
