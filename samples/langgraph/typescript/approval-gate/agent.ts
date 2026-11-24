/**
 * An agent whose refund tool cannot run until a person approves that exact call.
 *
 * LangChain's human-in-the-loop middleware pauses the agent before `issue_refund` runs.
 * `advance` asks a person about each paused call through CueHuman, and the webhook
 * endpoint (webhook-server.ts) resumes the run with the answer.
 */

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createAgent, humanInTheLoopMiddleware, tool, type ToolApprovalRequest } from "langchain";
import * as z from "zod";

import { createRequest } from "./cuehuman";

export const APPROVE = "Approve";
const REJECT = "Reject";

const usd = (amount: number) => `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

const issueRefund = tool(
  // Replace this with the real action.
  ({ order_id, amount_usd }) => `Refunded ${usd(amount_usd)} on order ${order_id}.`,
  {
    name: "issue_refund",
    description: "Refunds an order.",
    schema: z.object({ order_id: z.string(), amount_usd: z.number() }),
  },
);

/** What the approver reads: the exact call the agent wants to make. */
function describeRefund(toolCall: { args: Record<string, any> }): string {
  const { amount_usd, order_id } = toolCall.args;
  return `An AI agent wants to refund ${usd(amount_usd)} on order ${order_id}. Do you approve?`;
}

export const agent = createAgent({
  model: process.env.MODEL!,
  tools: [issueRefund],
  systemPrompt: "You handle billing problems. Refund an order when the customer is owed the money.",
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: { issue_refund: { allowedDecisions: ["approve", "reject"], description: describeRefund } },
      interruptMode: "per_call", // One pause, and one question, for each call.
    }),
  ],
  // A SQLite checkpointer, so a paused run survives a restart. Use Postgres in production.
  checkpointer: SqliteSaver.fromConnString("checkpoints.sqlite"),
});

/** Runs the agent until it finishes or pauses, then asks a person about each paused call. */
export async function advance(agentInput: Parameters<typeof agent.invoke>[0], threadId: string) {
  const result = await agent.invoke(agentInput, { configurable: { thread_id: threadId } });
  await askAboutPausedCalls(threadId);
  return result;
}

/** Creates one CueHuman request for each tool call the run is paused on. Safe to call again. */
export async function askAboutPausedCalls(threadId: string): Promise<void> {
  for (const paused of await pausedCalls(threadId)) {
    await createRequest({
      externalTaskId: `${threadId}:${paused.id}`, // How the webhook finds the run and the call.
      email: process.env.APPROVER_EMAIL!,
      prompt: paused.value.description,
      options: [APPROVE, REJECT],
    });
  }
}

/** The tool calls a run is paused on, each waiting for a person's decision. An answered call has a result. */
export async function pausedCalls(threadId: string): Promise<Array<{ id: string; value: ToolApprovalRequest }>> {
  const snapshot = await agent.graph.getState({ configurable: { thread_id: threadId } });
  const waiting = snapshot.tasks.filter((task) => task.result === undefined);
  return waiting.flatMap((task) => task.interrupts) as Array<{ id: string; value: ToolApprovalRequest }>;
}
