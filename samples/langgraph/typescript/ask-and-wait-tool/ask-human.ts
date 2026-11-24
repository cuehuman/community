/**
 * A LangChain tool that asks one person a question through CueHuman and waits for the answer.
 *
 * Reads CUEHUMAN_API_KEY from the environment.
 */

import { tool, type ToolRuntime } from "langchain";
import * as z from "zod";

const API_URL = process.env.CUEHUMAN_API_URL ?? "https://api.cuehuman.ai";
const ENDED = new Set(["completed", "expired", "canceled"]);

/** The parts of a CueHuman request this sample reads. */
interface CueHumanRequest {
  request_id: string;
  status: string;
  result: { choice?: string } | null;
  comment: string | null;
}

/** Builds the tool for one person. Your code picks who is asked; the model picks the question. */
export function makeAskHuman(email: string, maxWaitSeconds = 600) {
  return tool(
    async ({ question, options }, runtime: ToolRuntime) => {
      // The tool call's ID. An agent sets `toolCallId`; a direct call to the tool carries `toolCall`.
      const toolCallId = runtime.toolCallId ?? runtime.toolCall?.id;
      let request = await createRequest(`ask-human-${toolCallId}`, email, question, options, maxWaitSeconds);
      request = await waitForAnswer(request, maxWaitSeconds);
      if (request.status !== "completed") {
        return "The person did not answer in time. Do not carry out the action.";
      }
      let answer = `The person chose: ${request.result?.choice}.`;
      if (request.comment) answer += ` Their comment: ${request.comment}`;
      return answer;
    },
    {
      name: "ask_human",
      description:
        "Ask a person to choose one of the options, and wait for their answer. " +
        "Use this before an action that needs a person's approval or decision.",
      schema: z.object({
        question: z.string().describe("Shown to the person as written, so make it complete and specific."),
        options: z.array(z.string()).describe('The choices they pick from, for example ["Approve", "Reject"].'),
      }),
    },
  );
}

/** Sends the question. The tool call's ID is the task ID, so a retried call does not ask twice. */
async function createRequest(
  taskId: string,
  email: string,
  question: string,
  options: string[],
  expiresInSeconds: number,
): Promise<CueHumanRequest> {
  let response = await call("POST", "/v1/requests", {
    external_task_id: taskId,
    human: { email },
    type: "decision",
    prompt: question,
    schema: { options },
    allow_comment: true,
    // The request ends when the tool stops waiting, so no question is left open.
    expires_in_seconds: Math.max(60, expiresInSeconds),
  });
  if (response.status === 409) {
    response = await call("GET", `/v1/requests/${taskId}`); // Sent before, and its request has ended.
  }
  if (!response.ok) throw new Error(`CueHuman answered ${response.status}: ${await response.text()}`);
  return response.json();
}

/** Waits until the person answers, the request ends, or the time runs out. */
async function waitForAnswer(request: CueHumanRequest, maxWaitSeconds: number): Promise<CueHumanRequest> {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  while (!ENDED.has(request.status) && Date.now() < deadline) {
    let response: Response;
    try {
      // One call stays open for up to 25 seconds, and returns at once when the person answers.
      response = await call("GET", `/v1/requests/${request.request_id}?wait=25`);
    } catch {
      await sleep(5); // A dropped or timed-out connection. Ask again.
      continue;
    }
    if (response.status === 429) {
      await sleep(Math.min(Number(response.headers.get("Retry-After") ?? 5), 30)); // Too many calls are waiting.
      continue;
    }
    if (!response.ok) throw new Error(`CueHuman answered ${response.status}: ${await response.text()}`);
    request = await response.json();
  }
  return request;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`${API_URL}${path}`, {
        method,
        headers: { Authorization: `Bearer ${process.env.CUEHUMAN_API_KEY}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(40_000),
      });
    } catch (err) {
      // A dropped or timed-out connection. Both calls are safe to repeat.
      if (attempt === 2) throw err;
      await sleep(2 ** attempt);
    }
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
