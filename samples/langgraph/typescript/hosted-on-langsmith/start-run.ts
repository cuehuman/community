/**
 * Starts one run on the server and returns when it pauses for the human.
 *
 *     npm run start-run -- "Refund order 1042 for \$1,250.00" you@example.com
 */

import "dotenv/config";

import { Client } from "@langchain/langgraph-sdk";

const [action, approverEmail] = process.argv.slice(2);
// LANGGRAPH_URL is your deployment's address, or http://localhost:2024 for the local dev server.
const client = new Client({ apiUrl: process.env.LANGGRAPH_URL, apiKey: process.env.LANGSMITH_API_KEY });

const thread = await client.threads.create();
const result = (await client.runs.wait(thread.thread_id, "approval", { input: { action, approverEmail } })) as Record<string, unknown>;

console.log(`Thread:  ${thread.thread_id}`);
console.log(`Request: ${result.requestId}`);
console.log("__interrupt__" in result ? "Paused, waiting for the human." : `Finished: ${result.outcome}`);
console.log(`Check it later with: npm run show-run -- ${thread.thread_id}`);
