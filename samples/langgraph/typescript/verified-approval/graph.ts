/**
 * A high-risk approval: the approver proves they hold the address, and the answer's receipt is checked.
 *
 *     ask_human  ->  wait_for_human  ->  check_proof  ->  carry_out   (approved, verified, receipt valid)
 *                                                     ->  stop        (anything else)
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { END, START, StateGraph, StateSchema, interrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import * as z from "zod";

import { createRequest, getRequest, verifyReceipt } from "./cuehuman";

const APPROVE = "Approve";
const REJECT = "Reject";

const State = new StateSchema({
  action: z.string(), // What the agent wants to do, in words the approver will read.
  approverEmail: z.string(),
  requestId: z.string().optional(), // The CueHuman request this run is waiting on.
  // What the webhook endpoint resumed the run with.
  answer: z.object({ status: z.string(), choice: z.string().nullable(), comment: z.string().nullable() }).optional(),
  // Evidence of the approval, kept with the run.
  proof: z
    .object({
      verifiedAddress: z.string(),
      verifiedAt: z.string(),
      receipt: z.object({ hash: z.string(), signature: z.string(), key_id: z.string() }),
    })
    .optional(),
  refused: z.string().optional(), // Why the approval could not be relied on.
  outcome: z.string().optional(),
});
type State = typeof State.State;

/** Creates the request, with verification on. Its own node, so it is not repeated when the run resumes. */
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

/** Before acting on an approval, reads the request again and checks what CueHuman recorded. */
async function checkProof(state: State) {
  if (state.answer!.choice !== APPROVE) return {};
  const request = await getRequest(state.requestId!);
  const verification = request.verification;
  if (request.result?.choice !== APPROVE) return { refused: "the recorded answer is not an approval" };
  if (verification?.status !== "verified") return { refused: "the approver did not verify their address" };
  if (!(await verifyReceipt(request))) return { refused: "the receipt does not match the answer" };
  // Keep the evidence: who verified, when, and the signed receipt. Store the request too if you need it later.
  const proof = {
    verifiedAddress: verification.verified_contact!.value,
    verifiedAt: verification.verified_at!,
    receipt: request.receipt!,
  };
  return { proof };
}

function route(state: State): "carry_out" | "stop" {
  return state.proof ? "carry_out" : "stop";
}

function carryOut(state: State) {
  // Replace this with the real action.
  const proof = state.proof!;
  return { outcome: `Approved by ${proof.verifiedAddress}, verified at ${proof.verifiedAt}. Carried out: ${state.action}` };
}

function stop(state: State) {
  const answer = state.answer!;
  if (state.refused) return { outcome: `Not carried out: ${state.refused}.` };
  if (answer.choice === REJECT) return { outcome: `Rejected by the approver. Comment: ${answer.comment ?? "none"}` };
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
  .addNode("check_proof", checkProof)
  .addNode("carry_out", carryOut)
  .addNode("stop", stop)
  .addEdge(START, "ask_human")
  .addEdge("ask_human", "wait_for_human")
  .addEdge("wait_for_human", "check_proof")
  .addConditionalEdges("check_proof", route)
  .addEdge("carry_out", END)
  .addEdge("stop", END)
  .compile({ checkpointer: SqliteSaver.fromConnString("checkpoints.sqlite") });
