# Ask a person for details the workflow does not have

A workflow that pauses to collect information. The graph is ready to ship an order but has no delivery address, so it sends the customer a form, pauses, and continues with what they entered.

It builds on [pause and resume](../pause-and-resume/), and uses the same webhook endpoint. This page first shows the code you add to your own graph, then how to run the complete example in this folder.

## How it works

1. The graph creates a form request with the fields it needs, and pauses.
2. CueHuman emails the person a link to the form. CueHuman checks each answer against its field, so a form with a missing required answer or a badly formed email address is not accepted.
3. The person submits the form, and CueHuman calls your webhook with `request.human_submitted`.
4. The endpoint reads the request and resumes the run with the answers, keyed by field name.
5. If the request expires or is canceled, the run resumes with no answers and stops.

## Add it to your graph

### 1. Describe the form

From `graph.ts`:

```typescript
const DELIVERY_FIELDS = [
  { name: "street", type: "text", label: "Street address", required: true },
  { name: "city", type: "text", label: "City", required: true },
  { name: "postal_code", type: "text", label: "ZIP or postal code", required: true, max_length: 12 },
  { name: "speed", type: "select", label: "Delivery speed", options: ["Standard", "Express"], required: true },
  { name: "contact_email", type: "text", label: "Email for delivery updates", validation: "email" },
  { name: "notes", type: "textarea", label: "Notes for the driver", max_length: 500 },
];
```

Each field has a `name`, a `type` and a `label`. A `select` lists its `options`, and a `text` field can carry a `validation` rule such as `email`. A form can have up to 20 fields.

### 2. Create the form request in its own node

From `graph.ts`:

```typescript
/** Creates the form request. Its own node, so it is not repeated when the run resumes. */
async function askForDetails(state: State, config: RunnableConfig) {
  const request = await createFormRequest({
    externalTaskId: config.configurable!.thread_id, // How the webhook finds this run.
    email: state.customerEmail,
    prompt: `We are ready to ship ${state.order}. Where should we send it?`,
    fields: DELIVERY_FIELDS,
  });
  return { requestId: request.request_id };
}
```

It is the same call as an approval, with `type` set to `form` and the fields in `schema`. From `cuehuman.ts`:

```typescript
/** Asks one human to fill in a form. Safe to call again with the same externalTaskId. */
export async function createFormRequest(ask: {
  externalTaskId: string;
  email: string;
  prompt: string;
  fields: Array<Record<string, unknown>>;
}): Promise<CueHumanRequest> {
  const body: Record<string, unknown> = {
    external_task_id: ask.externalTaskId,
    human: { email: ask.email },
    type: "form",
    prompt: ask.prompt,
    schema: { fields: ask.fields },
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

### 3. Use the answers

From `graph.ts`:

```typescript
function shipOrder(state: State) {
  // Replace this with the real action. Each answer is under its field's name.
  const details = state.answer!.values!;
  const address = `${details.street}, ${details.city} ${details.postal_code}`;
  return { outcome: `Shipping ${state.order} to ${address} by ${details.speed} delivery.` };
}
```

The answers arrive in `result.values`, one for each field, under the field's `name`. A field left blank is `null`.

The webhook endpoint itself is the one from [pause and resume](../pause-and-resume/): it checks the `X-CueHuman-Signature` header, then resumes the run. It is part of your own app. The one change is what it passes to the run: the form's `values`, where the approval samples pass the choice.

## Run the complete example

| File | What it does |
|---|---|
| `graph.ts` | The graph and the form's fields |
| `webhook-server.ts` | The webhook endpoint that resumes the waiting run |
| `cuehuman.ts` | The CueHuman calls: create a form request, read it, check a webhook's signature |
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
npm run start-run -- "replacement order 1042" customer@example.com
```

Open the email and fill in the form. The endpoint logs the resume:

```
Resumed order-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Shipping replacement order 1042 to 12 Main St, Austin 78701 by Express delivery.
```

Check a run at any time:

```bash
npm run show-run -- order-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

## Before production

- Use a Postgres checkpointer in place of SQLite.
- Replace `shipOrder` with the real action.
- Switch to a `cue_live_` key to reach people outside your organization.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. Each run then appears in LangSmith as one trace that ends at the pause, and one more for each resume.
