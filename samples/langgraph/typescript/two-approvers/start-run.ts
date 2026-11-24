/**
 * Starts one run and exits while it waits for the approvers.
 *
 *     npm run start-run -- "Wire \$25,000.00 to Example Company" first@example.com second@example.com
 */

import "dotenv/config";

import crypto from "node:crypto";

import { graph, pausedBranches } from "./graph";

const [action, ...approverEmails] = process.argv.slice(2);
const threadId = `approval-${crypto.randomUUID()}`;
const config = { configurable: { thread_id: threadId } };

const result = await graph.invoke({ action, approverEmails }, config);
const waiting = (await pausedBranches(threadId)).length;

console.log(`Thread: ${threadId}`);
console.log(waiting > 0 ? `Paused, waiting for ${waiting} approvers.` : `Finished: ${result.outcome}`);
console.log(`Check it later with: npm run show-run -- ${threadId}`);
