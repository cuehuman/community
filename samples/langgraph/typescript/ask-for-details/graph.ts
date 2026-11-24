/**
 * A workflow that pauses to ask a person for details it does not have.
 *
 *     ask_for_details  ->  wait_for_details  ->  ship_order   (the person filled in the form)
 *                                            ->  stop         (no answer)
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { END, START, StateGraph, StateSchema, interrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import * as z from "zod";

import { createFormRequest } from "./cuehuman";

// The form the person fills in. CueHuman checks each answer against its field before it accepts the form.
const DELIVERY_FIELDS = [
  { name: "street", type: "text", label: "Street address", required: true },
  { name: "city", type: "text", label: "City", required: true },
  { name: "postal_code", type: "text", label: "ZIP or postal code", required: true, max_length: 12 },
  { name: "speed", type: "select", label: "Delivery speed", options: ["Standard", "Express"], required: true },
  { name: "contact_email", type: "text", label: "Email for delivery updates", validation: "email" },
  { name: "notes", type: "textarea", label: "Notes for the driver", max_length: 500 },
];

const State = new StateSchema({
  order: z.string(), // What is being shipped, in words the person will read.
  customerEmail: z.string(),
  requestId: z.string().optional(), // The CueHuman request this run is waiting on.
  // What the webhook endpoint resumed the run with.
  answer: z.object({ status: z.string(), values: z.record(z.string(), z.any()).nullable() }).optional(),
  outcome: z.string().optional(),
});
type State = typeof State.State;

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

/** Pauses the run until the webhook endpoint resumes it with what the person entered. */
function waitForDetails(state: State) {
  const answer = interrupt({ request_id: state.requestId });
  return { answer };
}

function route(state: State): "ship_order" | "stop" {
  return state.answer!.values ? "ship_order" : "stop";
}

function shipOrder(state: State) {
  // Replace this with the real action. Each answer is under its field's name.
  const details = state.answer!.values!;
  const address = `${details.street}, ${details.city} ${details.postal_code}`;
  return { outcome: `Shipping ${state.order} to ${address} by ${details.speed} delivery.` };
}

function stop(state: State) {
  return { outcome: `No details (request ${state.answer!.status}). Nothing was shipped.` };
}

/**
 * The graph, with a SQLite checkpointer so a paused run survives a restart.
 *
 * `start-run.ts` and `webhook-server.ts` both open the same file. Use Postgres in production.
 */
export const graph = new StateGraph(State)
  .addNode("ask_for_details", askForDetails)
  .addNode("wait_for_details", waitForDetails)
  .addNode("ship_order", shipOrder)
  .addNode("stop", stop)
  .addEdge(START, "ask_for_details")
  .addEdge("ask_for_details", "wait_for_details")
  .addConditionalEdges("wait_for_details", route)
  .addEdge("ship_order", END)
  .addEdge("stop", END)
  .compile({ checkpointer: SqliteSaver.fromConnString("checkpoints.sqlite") });
