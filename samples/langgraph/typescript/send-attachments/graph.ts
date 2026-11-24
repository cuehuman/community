/**
 * An approval where the approver gets something to look at: a file the agent uploads, and a link.
 *
 *     ask_human  ->  wait_for_human  ->  carry_out   (approved)
 *                                    ->  stop        (rejected, or no answer)
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { END, START, StateGraph, StateSchema, interrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import * as z from "zod";

import { createRequest, uploadAttachment } from "./cuehuman";

const APPROVE = "Approve";
const REJECT = "Reject";

const State = new StateSchema({
  documentPath: z.string(), // The file the approver should review, such as a PDF the agent prepared.
  link: z.string(), // A page the approver can open for more detail.
  approverEmail: z.string(),
  requestId: z.string().optional(), // The CueHuman request this run is waiting on.
  // What the webhook endpoint resumed the run with.
  answer: z.object({ status: z.string(), choice: z.string().nullable(), comment: z.string().nullable() }).optional(),
  outcome: z.string().optional(),
});
type State = typeof State.State;

/** Uploads the document, then creates the request with it attached. Its own node, so it is not repeated. */
async function askHuman(state: State, config: RunnableConfig) {
  const attachmentId = await uploadAttachment(state.documentPath, "application/pdf");
  const request = await createRequest({
    externalTaskId: config.configurable!.thread_id, // How the webhook finds this run.
    email: state.approverEmail,
    prompt: "An AI agent prepared the attached quote. Please review it before it goes to the customer. Do you approve?",
    options: [APPROVE, REJECT],
    attachments: [
      // A file: the approver gets a download control. `name` is the title they see.
      { id: attachmentId, name: "Quote for order 1042", description: "The PDF the customer will receive." },
      // A link: CueHuman shows it and never fetches it.
      { url: state.link, name: "Order 1042", description: "The order in your own system." },
    ],
  });
  return { requestId: request.request_id };
}

/** Pauses the run until the webhook endpoint resumes it with the human's answer. */
function waitForHuman(state: State) {
  const answer = interrupt({ request_id: state.requestId });
  return { answer };
}

function route(state: State): "carry_out" | "stop" {
  return state.answer!.choice === APPROVE ? "carry_out" : "stop";
}

function carryOut(state: State) {
  // Replace this with the real action.
  return { outcome: `Approved. Sent ${state.documentPath} to the customer.` };
}

function stop(state: State) {
  const answer = state.answer!;
  if (answer.choice === REJECT) {
    return { outcome: `Rejected by the approver. Comment: ${answer.comment ?? "none"}` };
  }
  return { outcome: `No answer (request ${answer.status}). Nothing was done.` };
}

/**
 * The graph, with a SQLite checkpointer so a paused run survives a restart.
 *
 * `start-run.ts` and `webhook-server.ts` both open the same file. Use Postgres in production.
 */
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
  .compile({ checkpointer: SqliteSaver.fromConnString("checkpoints.sqlite") });
