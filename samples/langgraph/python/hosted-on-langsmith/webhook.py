"""A route added to the LangGraph server: receives CueHuman webhooks and resumes the run that is waiting.

`langgraph.json` names this app under "http", so the server serves it beside its own API.
"""

import asyncio
import json
import logging

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from langgraph_sdk import get_client

import cuehuman

log = logging.getLogger("cuehuman-webhook")

ASSISTANT = "approval"  # The graph's name in langgraph.json.
RESUMING_EVENTS = {"request.human_submitted", "request.expired", "request.canceled"}

app = FastAPI()


@app.post("/webhooks/cuehuman")
async def cuehuman_webhook(request: Request, background: BackgroundTasks) -> dict:
    raw_body = await request.body()  # The signature covers these exact bytes.
    if not cuehuman.verify_webhook(raw_body, request.headers.get("X-CueHuman-Signature", "")):
        raise HTTPException(status_code=401, detail="Invalid signature")
    event = json.loads(raw_body)
    if event["event"] in RESUMING_EVENTS:
        background.add_task(resume_run, event)  # Answer first: CueHuman waits 8 seconds for the reply.
    return {"received": True}


async def resume_run(event: dict) -> None:
    client = get_client()  # With no address, this reaches the server it is running in.
    thread_id = event["external_task_id"]

    # Resume only a run that is paused on this request. A repeated or late event finds none.
    paused_on = [paused["value"].get("request_id") for paused in await paused_at(client, thread_id)]
    if event["request_id"] not in paused_on:
        log.info("Ignored %s for %s: no run is paused on it", event["event"], event["request_id"])
        return

    # The event says what happened, not what the human answered. Read the request for that.
    request = await asyncio.to_thread(cuehuman.get_request, event["request_id"])
    answer = {
        "status": request["status"],
        "choice": (request["result"] or {}).get("choice"),
        "comment": request["comment"],
    }
    result = await client.runs.wait(thread_id, ASSISTANT, command={"resume": answer})
    log.info("Resumed %s after %s -> %s", thread_id, event["event"], result.get("outcome"))


async def paused_at(client, thread_id: str) -> list[dict]:
    """The pauses of a thread's run. Empty when the thread is unknown or is not paused."""
    try:
        state = await client.threads.get_state(thread_id)
    except Exception:  # The task ID is not one of this server's threads.
        return []
    return [paused for task in state["tasks"] for paused in task["interrupts"]]
