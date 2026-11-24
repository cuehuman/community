/**
 * Starts one run and exits while it waits for the person.
 *
 *     npm run start-run -- "Customer 8841 was double charged \$1,250.00 on order 1042. Please fix it."
 */

import "dotenv/config";

import crypto from "node:crypto";

import { advance, pausedCalls } from "./agent";

const threadId = `refund-${crypto.randomUUID()}`;
const result = await advance({ messages: [{ role: "user", content: process.argv[2] }] }, threadId);
const paused = await pausedCalls(threadId);

console.log(`Thread: ${threadId}`);
if (paused.length > 0) {
  for (const call of paused) console.log(`Paused, waiting for a person: ${call.value.description}`);
  console.log(`Check it later with: npm run show-run -- ${threadId}`);
} else {
  console.log(`Finished: ${result.messages.at(-1)?.text}`);
}
