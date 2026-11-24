/**
 * An approval workflow for a LangGraph server: a deployment on LangSmith, or the local dev server.
 *
 *     ask_human  ->  wait_for_human  ->  carry_out   (approved)
 *                                    ->  stop        (rejected, or no answer)
 *
 * The server saves each run, so the graph is compiled with no checkpointer of its own.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { END, START, StateGraph, StateSchema, interrupt } from "@langchain/langgraph";
import * as z from "zod";

import { createRequest } from "./cuehuman";

const APPROVE = "Approve";
const REJECT = "Reject";

const State = new StateSchema({
  action: z.string(), // What the agent wants to do, in words the approver will read.
  approverEmail: z.string(),
  requestId: z.string().optional(), // The CueHuman request this run is waiting on.
  // What the webhook endpoint resumed the run with.
  answer: z.object({ status: z.string(), choice: z.string().nullable(), comment: z.string().nullable() }).optional(),
  outcome: z.string().optional(),
});
type State = typeof State.State;

/** Creates the CueHuman request. Its own node, so it is not repeated when the run resumes. */
async function askHuman(state: State, config: RunnableConfig) {
  const request = await createRequest({
    externalTaskId: config.configurable!.thread_id, // How the webhook finds this run.
    email: state.approverEmail,
    prompt: `An AI agent wants to: ${state.action}. Do you approve?`,
    options: [APPROVE, REJECT],
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
  return { outcome: `Approved. Carried out: ${state.action}` };
}

function stop(state: State) {
  const answer = state.answer!;
  if (answer.choice === REJECT) {
    return { outcome: `Rejected by the approver. Comment: ${answer.comment ?? "none"}` };
  }
  return { outcome: `No answer (request ${answer.status}). Nothing was done.` };
}

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
