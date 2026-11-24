"""The webhook endpoint: receives CueHuman webhooks and resumes the run with the person's decision.

    uvicorn webhook_server:app --port 8000
"""

import json
import logging

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from langgraph.types import Command

load_dotenv()

import cuehuman  # noqa: E402  (after load_dotenv, so it sees the environment)
from agent import APPROVE, advance, agent  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("cuehuman-webhook")

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


def resume_run(event: dict) -> None:
    thread_id, paused_id = event["external_task_id"].split(":", 1)

    # Resume only a run that is paused on this call. A repeated or late event finds none.
    paused_calls = agent.get_state({"configurable": {"thread_id": thread_id}}).interrupts
    if paused_id not in [paused.id for paused in paused_calls]:
        log.info("Ignored %s for %s: no run is paused on it", event["event"], event["request_id"])
        return

    # The event says what happened, not what the human answered. Read the request for that.
    request = cuehuman.get_request(event["request_id"])
    if (request["result"] or {}).get("choice") == APPROVE:
        decision = {"type": "approve"}
    elif request["status"] == "completed":
        decision = {"type": "reject", "message": request["comment"] or "The approver rejected this call."}
    else:
        message = f"Nobody approved this call (the request {request['status']}), so it did not run. Do not try again."
        decision = {"type": "reject", "message": message}

    result = advance(Command(resume={paused_id: decision}), thread_id)
    if result.interrupts:
        log.info("Resumed %s with %s; it is now waiting on another call", thread_id, decision["type"])
    else:
        log.info("Resumed %s with %s -> %s", thread_id, decision["type"], result.value["messages"][-1].text)
