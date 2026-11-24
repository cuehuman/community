/**
 * An agent that must ask a person before it issues a refund.
 *
 *     npm run agent -- "Customer 8841 was double charged \$1,250.00 on order 1042. Please fix it."
 */

import "dotenv/config";

import { createAgent, tool } from "langchain";
import * as z from "zod";

import { makeAskHuman } from "./ask-human";

const issueRefund = tool(
  // Replace this with the real action.
  ({ order_id, amount_usd }) =>
    `Refunded $${amount_usd.toLocaleString("en-US", { minimumFractionDigits: 2 })} on order ${order_id}.`,
  {
    name: "issue_refund",
    description: "Refunds an order. Only call this after a person has approved the refund.",
    schema: z.object({ order_id: z.string(), amount_usd: z.number() }),
  },
);

const agent = createAgent({
  model: process.env.MODEL!,
  tools: [makeAskHuman(process.env.APPROVER_EMAIL!), issueRefund],
  systemPrompt:
    "You handle billing problems. Before any refund, call ask_human with the order, the amount and " +
    'the reason, and the options ["Approve", "Reject"]. Issue the refund only if the person approves.',
});

const result = await agent.invoke({ messages: [{ role: "user", content: process.argv[2] }] });
console.log(result.messages.at(-1)?.content);
