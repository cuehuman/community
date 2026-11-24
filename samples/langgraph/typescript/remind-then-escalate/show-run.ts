/**
 * Shows where a run is.
 *
 *     npm run show-run -- approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
 */

import "dotenv/config";

import { graph } from "./graph";

const snapshot = await graph.getState({ configurable: { thread_id: process.argv[2] } });

if (Object.keys(snapshot.values).length === 0) {
  console.log("No run with that thread ID.");
} else if (snapshot.next.length > 0) {
  console.log(`Paused, waiting on the ${snapshot.values.stage} request ${snapshot.values.requestId}.`);
} else {
  console.log(`Finished: ${snapshot.values.outcome}`);
}
