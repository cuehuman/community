/**
 * An approval that does not wait forever: remind the approver once, then ask a backup.
 *
 *     ask_human -> wait_for_human -> carry_out            (approved)
 *                                 -> stop                 (rejected, canceled, or nobody answered)
 *                                 -> remind -> wait_for_human      (first request expired)
 *                                 -> escalate -> wait_for_human    (the reminder expired too)
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { END, START, StateGraph, StateSchema, interrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import * as z from "zod";

import { createRequest, reissueRequest } from "./cuehuman";

const APPROVE = "Approve";
const REJECT = "Reject";
// How long each person has to answer, in seconds. One day unless ANSWER_WITHIN_SECONDS says otherwise.
const ANSWER_WITHIN = Number(process.env.ANSWER_WITHIN_SECONDS ?? 86400);

const State = new StateSchema({
  action: z.string(), // What the agent wants to do, in words the approver will read.
  approverEmail: z.string(),
  backupEmail: z.string(),
  requestId: z.string().optional(), // The CueHuman request this run is waiting on.
  stage: z.enum(["first", "reminder", "backup"]).optional(), // Which request that is.
  // What the webhook endpoint resumed the run with.
  answer: z.object({ status: z.string(), choice: z.string().nullable(), comment: z.string().nullable() }).optional(),
  outcome: z.string().optional(),
});
type State = typeof State.State;

/** Asks the approver. The task ID starts with the thread ID, so the webhook can find this run. */
async function askHuman(state: State, config: RunnableConfig) {
  const request = await createRequest({
    externalTaskId: `${config.configurable!.thread_id}:first`,
    email: state.approverEmail,
    prompt: `An AI agent wants to: ${state.action}. Do you approve?`,
    options: [APPROVE, REJECT],
    expiresInSeconds: ANSWER_WITHIN,
  });
  return { requestId: request.request_id, stage: "first" as const };
}

/** Pauses the run until the webhook endpoint resumes it: with an answer, or with none. */
function waitForHuman(state: State) {
  const answer = interrupt({ request_id: state.requestId });
  return { answer };
}

function route(state: State): "carry_out" | "stop" | "remind" | "escalate" {
  const answer = state.answer!;
  if (answer.choice === APPROVE) return "carry_out";
  if (answer.choice === REJECT || answer.status !== "expired") return "stop";
  // Nobody answered in time. Remind the approver once, then ask the backup once.
  return ({ first: "remind", reminder: "escalate", backup: "stop" } as const)[state.stage!];
}

/** Sends the expired request to the same approver again. CueHuman calls this a reissue. */
async function remind(state: State, config: RunnableConfig) {
  const request = await reissueRequest(state.requestId!, {
    externalTaskId: `${config.configurable!.thread_id}:reminder`,
    expiresInSeconds: ANSWER_WITHIN,
  });
  return { requestId: request.request_id, stage: "reminder" as const };
}

/** Asks the backup approver, with a new request. */
async function escalate(state: State, config: RunnableConfig) {
  const request = await createRequest({
    externalTaskId: `${config.configurable!.thread_id}:backup`,
    email: state.backupEmail,
    prompt: `An AI agent wants to: ${state.action}. The first approver did not answer. Do you approve?`,
    options: [APPROVE, REJECT],
    expiresInSeconds: ANSWER_WITHIN,
  });
  return { requestId: request.request_id, stage: "backup" as const };
}

function carryOut(state: State) {
  // Replace this with the real action.
  const by = state.stage === "backup" ? "the backup approver" : "the approver";
  return { outcome: `Approved by ${by}. Carried out: ${state.action}` };
}

function stop(state: State) {
  const answer = state.answer!;
  if (answer.choice === REJECT) return { outcome: `Rejected. Comment: ${answer.comment ?? "none"}` };
  if (answer.status === "expired") {
    return { outcome: "Nobody answered: not the approver, after a reminder, nor the backup. Nothing was done." };
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
  .addNode("remind", remind)
  .addNode("escalate", escalate)
  .addNode("carry_out", carryOut)
  .addNode("stop", stop)
  .addEdge(START, "ask_human")
  .addEdge("ask_human", "wait_for_human")
  .addConditionalEdges("wait_for_human", route)
  .addEdge("remind", "wait_for_human")
  .addEdge("escalate", "wait_for_human")
  .addEdge("carry_out", END)
  .addEdge("stop", END)
  .compile({ checkpointer: SqliteSaver.fromConnString("checkpoints.sqlite") });
