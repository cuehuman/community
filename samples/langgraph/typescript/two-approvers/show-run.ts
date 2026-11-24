/**
 * Shows where a run is.
 *
 *     npm run show-run -- approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
 */

import "dotenv/config";

import { graph, pausedBranches } from "./graph";

const threadId = process.argv[2];
const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
const waiting = (await pausedBranches(threadId)).length;

if (Object.keys(snapshot.values).length === 0) {
  console.log("No run with that thread ID.");
} else if (waiting > 0) {
  console.log(`Paused: ${Object.keys(snapshot.values.answers ?? {}).length} answered, ${waiting} still waiting.`);
} else {
  console.log(`Finished: ${snapshot.values.outcome}`);
}
