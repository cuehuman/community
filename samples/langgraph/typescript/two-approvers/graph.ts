/**
 * An action that needs every approver to say yes. Each is asked at the same time, in a separate request.
 *
 *     ask_approvers  ->  wait_for_approver (one for each approver, side by side)  ->  decide
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, START, Send, StateGraph, interrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import { createRequest } from "./cuehuman";

const APPROVE = "Approve";
const REJECT = "Reject";

interface Answer {
  status: string;
  choice: string | null;
  comment: string | null;
}

const State = Annotation.Root({
  action: Annotation<string>, // What the agent wants to do, in words the approvers will read.
  approverEmails: Annotation<string[]>,
  requests: Annotation<Record<string, string>>, // Each approver's email, and the CueHuman request sent to them.
  // Each approver's email, and their answer. The branches run side by side, so their answers are merged.
  answers: Annotation<Record<string, Answer>>({ reducer: (all, more) => ({ ...all, ...more }), default: () => ({}) }),
  outcome: Annotation<string>,
});
type State = typeof State.State;

/** Creates one request for each approver. Its own node, so it is not repeated when the run resumes. */
async function askApprovers(state: State, config: RunnableConfig) {
  const threadId = config.configurable!.thread_id;
  const requests: Record<string, string> = {};
  for (const [index, email] of state.approverEmails.entries()) {
    const request = await createRequest({
      externalTaskId: `${threadId}:${index + 1}`, // Starts with the thread ID, so the webhook finds this run.
      email,
      prompt: `An AI agent wants to: ${state.action}. Every approver must agree. Do you approve?`,
      options: [APPROVE, REJECT],
    });
    requests[email] = request.request_id;
  }
  return { requests };
}

function oneBranchForEachApprover(state: State): Send[] {
  return Object.entries(state.requests).map(
    ([email, requestId]) => new Send("wait_for_approver", { email, requestId }),
  );
}

/** Pauses this approver's branch until the webhook endpoint resumes it with their answer. */
function waitForApprover(branch: { email: string; requestId: string }) {
  const answer: Answer = interrupt({ request_id: branch.requestId });
  return { answers: { [branch.email]: answer } };
}

/** Runs once every branch has an answer. The action needs a yes from every approver. */
function decide(state: State) {
  const notApproved = Object.entries(state.answers).filter(([, answer]) => answer.choice !== APPROVE);
  if (notApproved.length === 0) {
    // Replace this with the real action.
    return { outcome: `Approved by all ${Object.keys(state.answers).length} approvers. Carried out: ${state.action}` };
  }
  const reasons = notApproved.map(([email, answer]) =>
    answer.choice === REJECT ? `${email} rejected (${answer.comment ?? "no comment"})` : `${email} did not answer`,
  );
  return { outcome: `Not approved: ${reasons.join("; ")}. Nothing was done.` };
}

/**
 * The graph, with a SQLite checkpointer so a paused run survives a restart.
 *
 * `start-run.ts` and `webhook-server.ts` both open the same file. Use Postgres in production.
 */
export const graph = new StateGraph(State)
  .addNode("ask_approvers", askApprovers)
  .addNode("wait_for_approver", waitForApprover)
  .addNode("decide", decide)
  .addEdge(START, "ask_approvers")
  .addConditionalEdges("ask_approvers", oneBranchForEachApprover, ["wait_for_approver"])
  .addEdge("wait_for_approver", "decide")
  .addEdge("decide", END)
  .compile({ checkpointer: SqliteSaver.fromConnString("checkpoints.sqlite") });

/** The branches of a run that are still paused. A branch that has been answered has a result. */
export async function pausedBranches(threadId: string) {
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  return snapshot.tasks.filter((task) => task.result === undefined).flatMap((task) => task.interrupts);
}
