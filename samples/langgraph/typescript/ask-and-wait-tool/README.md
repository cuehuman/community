# A tool that lets an agent ask a person and wait for the answer

`ask_human` is a LangChain tool. The agent calls it with a question and a list of options. The tool sends the question through CueHuman and returns the person's choice to the agent.

Use this when the answer is expected within a few minutes: the agent's run stays open while it waits. For a wait of hours or days, use [pause and resume](../pause-and-resume/).

This page first shows the code you add to your own agent, then how to run the complete example in this folder.

## How it works

1. The agent calls `ask_human(question, options)`.
2. The tool creates a CueHuman request, and CueHuman emails the person a link to the request form.
3. The tool waits until the person answers.
4. The tool returns the choice, and any comment, to the agent.
5. If nobody answers within the wait limit (10 minutes by default), the tool tells the agent not to act.

## Add it to your agent

### 1. Build the tool for one person

From `ask-human.ts`:

```typescript
/** Builds the tool for one person. Your code picks who is asked; the model picks the question. */
export function makeAskHuman(email: string, maxWaitSeconds = 600) {
  return tool(
    async ({ question, options }, runtime: ToolRuntime) => {
      // The tool call's ID. An agent sets `toolCallId`; a direct call to the tool carries `toolCall`.
      const toolCallId = runtime.toolCallId ?? runtime.toolCall?.id;
      let request = await createRequest(`ask-human-${toolCallId}`, email, question, options, maxWaitSeconds);
      request = await waitForAnswer(request, maxWaitSeconds);
      if (request.status !== "completed") {
        return "The person did not answer in time. Do not carry out the action.";
      }
      let answer = `The person chose: ${request.result?.choice}.`;
      if (request.comment) answer += ` Their comment: ${request.comment}`;
      return answer;
    },
    {
      name: "ask_human",
      description:
        "Ask a person to choose one of the options, and wait for their answer. " +
        "Use this before an action that needs a person's approval or decision.",
      schema: z.object({
        question: z.string().describe("Shown to the person as written, so make it complete and specific."),
        options: z.array(z.string()).describe('The choices they pick from, for example ["Approve", "Reject"].'),
      }),
    },
  );
}
```

- **Your code chooses who is asked, not the model.** The address is fixed when the tool is built. The model sees only `question` and `options`.
- **A retried tool call does not ask twice.** The tool call's ID is sent as `external_task_id`, so a repeat returns the same request.

### 2. Send the question

From `ask-human.ts`:

```typescript
/** Sends the question. The tool call's ID is the task ID, so a retried call does not ask twice. */
async function createRequest(
  taskId: string,
  email: string,
  question: string,
  options: string[],
  expiresInSeconds: number,
): Promise<CueHumanRequest> {
  let response = await call("POST", "/v1/requests", {
    external_task_id: taskId,
    human: { email },
    type: "decision",
    prompt: question,
    schema: { options },
    allow_comment: true,
    // The request ends when the tool stops waiting, so no question is left open.
    expires_in_seconds: Math.max(60, expiresInSeconds),
  });
  if (response.status === 409) {
    response = await call("GET", `/v1/requests/${taskId}`); // Sent before, and its request has ended.
  }
  if (!response.ok) throw new Error(`CueHuman answered ${response.status}: ${await response.text()}`);
  return response.json();
}
```

### 3. Wait for the answer

From `ask-human.ts`:

```typescript
/** Waits until the person answers, the request ends, or the time runs out. */
async function waitForAnswer(request: CueHumanRequest, maxWaitSeconds: number): Promise<CueHumanRequest> {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  while (!ENDED.has(request.status) && Date.now() < deadline) {
    let response: Response;
    try {
      // One call stays open for up to 25 seconds, and returns at once when the person answers.
      response = await call("GET", `/v1/requests/${request.request_id}?wait=25`);
    } catch {
      await sleep(5); // A dropped or timed-out connection. Ask again.
      continue;
    }
    if (response.status === 429) {
      await sleep(Math.min(Number(response.headers.get("Retry-After") ?? 5), 30)); // Too many calls are waiting.
      continue;
    }
    if (!response.ok) throw new Error(`CueHuman answered ${response.status}: ${await response.text()}`);
    request = await response.json();
  }
  return request;
}
```

No webhook is needed: the tool reads the request with `wait=25`, which CueHuman holds open until the person answers. A dropped connection does not end the wait: the tool asks again until the time runs out.

### 4. Give the tool to your agent

From `agent.ts`:

```typescript
const agent = createAgent({
  model: process.env.MODEL!,
  tools: [makeAskHuman(process.env.APPROVER_EMAIL!), issueRefund],
  systemPrompt:
    "You handle billing problems. Before any refund, call ask_human with the order, the amount and " +
    'the reason, and the options ["Approve", "Reject"]. Issue the refund only if the person approves.',
});
```

## Run the complete example

| File | What it does |
|---|---|
| `ask-human.ts` | `makeAskHuman(email)`, which builds the tool |
| `agent.ts` | An agent that must ask before it issues a refund |

You need Node.js 20 or later.

```bash
npm install
cp .env.example .env
```

Fill in `.env`: your CueHuman agent key, the address of the person to ask, and a model with its provider's key. To use another provider, install its LangChain package and change `MODEL`.

```bash
npm run agent -- "Customer 8841 was double charged \$1,250.00 on order 1042. Please fix it."
```

The agent asks for approval, you answer from the email, and the agent finishes.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. The wait shows up as the length of the `ask_human` tool call.
