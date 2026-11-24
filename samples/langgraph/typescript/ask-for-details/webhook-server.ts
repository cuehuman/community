/**
 * The webhook endpoint: receives CueHuman webhooks and resumes the run that is waiting.
 *
 *     npm run webhook
 */

import "dotenv/config";

import { Command } from "@langchain/langgraph";
import express from "express";

import { getRequest, verifyWebhook } from "./cuehuman";
import { graph } from "./graph";

const RESUMING_EVENTS = new Set(["request.human_submitted", "request.expired", "request.canceled"]);

/** The parts of a CueHuman webhook event this sample reads. */
interface WebhookEvent {
  event: string;
  request_id: string;
  external_task_id: string;
}

const app = express();

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
  // A form's answers are in `result.values`, keyed by field name. There is no result without an answer.
  const answer = { status: request.status, values: request.result?.values ?? null };
  const result = await graph.invoke(new Command({ resume: answer }), config);
  console.log(`Resumed ${threadId} after ${event.event} -> ${result.outcome}`);
}

const port = Number(process.env.PORT ?? 8000);
app.listen(port, () => console.log(`Webhook endpoint listening on http://localhost:${port}/webhooks/cuehuman`));
