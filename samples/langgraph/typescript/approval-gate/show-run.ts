/**
 * Shows where a run is.
 *
 *     npm run show-run -- refund-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
 */

import "dotenv/config";

import { agent, pausedCalls } from "./agent";

const threadId = process.argv[2];
const snapshot = await agent.graph.getState({ configurable: { thread_id: threadId } });
const paused = await pausedCalls(threadId);

if (Object.keys(snapshot.values).length === 0) {
  console.log("No run with that thread ID.");
} else if (paused.length > 0) {
  for (const call of paused) console.log(`Paused, waiting for a person: ${call.value.description}`);
} else {
  console.log(`Finished: ${snapshot.values.messages.at(-1)?.text}`);
}
