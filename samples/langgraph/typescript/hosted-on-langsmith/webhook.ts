/**
 * A route added to the LangGraph server: receives CueHuman webhooks and resumes the run that is waiting.
 *
 * `langgraph.json` names this app under "http", so the server serves it beside its own API.
 */

import { Client } from "@langchain/langgraph-sdk";
import { Hono } from "hono";

import { getRequest, verifyWebhook } from "./cuehuman";

const ASSISTANT = "approval"; // The graph's name in langgraph.json.
const RESUMING_EVENTS = new Set(["request.human_submitted", "request.expired", "request.canceled"]);

/** The parts of a CueHuman webhook event this sample reads. */
interface WebhookEvent {
  event: string;
  request_id: string;
  external_task_id: string;
}

export const app = new Hono();

app.post("/webhooks/cuehuman", async (c) => {
  const rawBody = Buffer.from(await c.req.arrayBuffer()); // The signature covers these exact bytes.
  if (!verifyWebhook(rawBody, c.req.header("X-CueHuman-Signature") ?? "")) {
    return c.json({ error: "Invalid signature" }, 401);
  }
  const event: WebhookEvent = JSON.parse(rawBody.toString("utf8"));
  if (RESUMING_EVENTS.has(event.event)) {
    // The server's own API: LANGGRAPH_URL when it is set, or the address this call came in on.
    const apiUrl = process.env.LANGGRAPH_URL ?? new URL(c.req.url).origin;
    const client = new Client({ apiUrl, apiKey: process.env.LANGSMITH_API_KEY });
    // Answer first, then do the work: CueHuman waits 8 seconds for the reply.
    resumeRun(client, event).catch((err) => console.error(`Could not resume ${event.external_task_id}:`, err));
  }
  return c.json({ received: true });
});

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

/** The pauses of a thread's run. Empty when the thread is unknown or is not paused. */
async function pausedAt(client: Client, threadId: string) {
  try {
    const state = await client.threads.getState(threadId);
    return state.tasks.flatMap((task) => task.interrupts);
  } catch {
    return []; // The task ID is not one of this server's threads.
  }
}
