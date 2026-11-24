/**
 * The webhook endpoint: receives CueHuman webhooks and resumes the run that is waiting.
 *
 *     npm run webhook
 */

import "dotenv/config";

import { Command } from "@langchain/langgraph";
import express from "express";

import { getRequest, verifyWebhook } from "./cuehuman";
import { graph, pausedBranches } from "./graph";

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

const port = Number(process.env.PORT ?? 8000);
app.listen(port, () => console.log(`Webhook endpoint listening on http://localhost:${port}/webhooks/cuehuman`));
