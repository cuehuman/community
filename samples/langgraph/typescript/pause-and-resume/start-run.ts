/**
 * Starts one run and exits while it waits for the human.
 *
 *     npm run start-run -- "Refund order 1042 for \$1,250.00" you@example.com
 */

import "dotenv/config";

import crypto from "node:crypto";

import { graph } from "./graph";

const [action, approverEmail] = process.argv.slice(2);
const threadId = `approval-${crypto.randomUUID()}`;

const result = await graph.invoke({ action, approverEmail }, { configurable: { thread_id: threadId } });

console.log(`Thread:  ${threadId}`);
console.log(`Request: ${result.requestId}`);
console.log("__interrupt__" in result ? "Paused, waiting for the human." : `Finished: ${result.outcome}`);
console.log(`Check it later with: npm run show-run -- ${threadId}`);
