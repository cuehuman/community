/**
 * The webhook endpoint: receives CueHuman webhooks and resumes the run with the person's decision.
 *
 *     npm run webhook
 */

import "dotenv/config";

import { Command } from "@langchain/langgraph";
import express from "express";

import { APPROVE, advance, pausedCalls } from "./agent";
import { getRequest, verifyWebhook } from "./cuehuman";

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

const port = Number(process.env.PORT ?? 8000);
app.listen(port, () => console.log(`Webhook endpoint listening on http://localhost:${port}/webhooks/cuehuman`));
