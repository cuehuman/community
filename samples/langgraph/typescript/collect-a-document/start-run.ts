/**
 * Starts one run and exits while it waits for the human.
 *
 *     npm run start-run -- "your damage claim for order 1042" customer@example.com
 */

import "dotenv/config";

import crypto from "node:crypto";

import { graph } from "./graph";

const [claim, customerEmail] = process.argv.slice(2);
const threadId = `claim-${crypto.randomUUID()}`;

const result = await graph.invoke({ claim, customerEmail }, { configurable: { thread_id: threadId } });

console.log(`Thread:  ${threadId}`);
console.log(`Request: ${result.requestId}`);
console.log("__interrupt__" in result ? "Paused, waiting for the human." : `Finished: ${result.outcome}`);
console.log(`Check it later with: npm run show-run -- ${threadId}`);
