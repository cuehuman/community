/**
 * A workflow that pauses until a person uploads the documents it needs.
 *
 *     ask_for_documents  ->  wait_for_documents  ->  save_documents   (the person uploaded files)
 *                                                ->  stop             (no answer)
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { END, START, StateGraph, StateSchema, interrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import * as z from "zod";

import { createFileRequest, downloadFiles } from "./cuehuman";

const CATEGORIES = ["Receipt", "Photo of the damage"];

const State = new StateSchema({
  claim: z.string(), // What the documents are for, in words the person will read.
  customerEmail: z.string(),
  requestId: z.string().optional(), // The CueHuman request this run is waiting on.
  // What the webhook endpoint resumed the run with.
  answer: z
    .object({
      status: z.string(),
      files: z.array(z.object({ id: z.string(), name: z.string(), category: z.string().nullable(), size_bytes: z.number() })),
    })
    .optional(),
  outcome: z.string().optional(),
});
type State = typeof State.State;

/** Creates the file request. Its own node, so it is not repeated when the run resumes. */
async function askForDocuments(state: State, config: RunnableConfig) {
  const request = await createFileRequest({
    externalTaskId: config.configurable!.thread_id, // How the webhook finds this run.
    email: state.customerEmail,
    prompt: `To finish ${state.claim}, please upload your receipt and a photo of the damage.`,
    categories: CATEGORIES,
  });
  return { requestId: request.request_id };
}

/** Pauses the run until the webhook endpoint resumes it with the list of uploaded files. */
function waitForDocuments(state: State) {
  const answer = interrupt({ request_id: state.requestId });
  return { answer };
}

function route(state: State): "save_documents" | "stop" {
  return state.answer!.files.length > 0 ? "save_documents" : "stop";
}

/** Downloads the files into a folder for this run. Replace this with your own storage. */
async function saveDocuments(state: State, config: RunnableConfig) {
  const folder = `received/${config.configurable!.thread_id}`;
  const saved = await downloadFiles(state.requestId!, folder);
  const labels = state.answer!.files.map((file) => `${file.name} (${file.category})`).join(", ");
  return { outcome: `Saved ${saved.length} files to ${folder}: ${labels}` };
}

function stop(state: State) {
  return { outcome: `No documents (request ${state.answer!.status}). The claim was left open.` };
}

/**
 * The graph, with a SQLite checkpointer so a paused run survives a restart.
 *
 * `start-run.ts` and `webhook-server.ts` both open the same file. Use Postgres in production.
 */
export const graph = new StateGraph(State)
  .addNode("ask_for_documents", askForDocuments)
  .addNode("wait_for_documents", waitForDocuments)
  .addNode("save_documents", saveDocuments)
  .addNode("stop", stop)
  .addEdge(START, "ask_for_documents")
  .addEdge("ask_for_documents", "wait_for_documents")
  .addConditionalEdges("wait_for_documents", route)
  .addEdge("save_documents", END)
  .addEdge("stop", END)
  .compile({ checkpointer: SqliteSaver.fromConnString("checkpoints.sqlite") });
