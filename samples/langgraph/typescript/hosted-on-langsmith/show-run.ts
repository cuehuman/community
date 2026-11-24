/**
 * Shows where a run is.
 *
 *     npm run show-run -- 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
 */

import "dotenv/config";

import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: process.env.LANGGRAPH_URL, apiKey: process.env.LANGSMITH_API_KEY });
const state = await client.threads.getState<{ requestId?: string; outcome?: string }>(process.argv[2]);

if (state.next.length > 0) {
  console.log(`Paused at ${state.next[0]}, waiting on request ${state.values.requestId}.`);
} else {
  console.log(`Finished: ${state.values.outcome}`);
}
