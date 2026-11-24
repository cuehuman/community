"""The webhook endpoint: receives CueHuman webhooks and resumes the run that is waiting.

    uvicorn webhook_server:app --port 8000
"""

import json
import logging

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from langgraph.types import Command

load_dotenv()

import cuehuman  # noqa: E402  (after load_dotenv, so it sees the environment)
from graph import build_graph  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("cuehuman-webhook")

RESUMING_EVENTS = {"request.human_submitted", "request.expired", "request.canceled"}

app = FastAPI()
graph = build_graph()


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
    thread_id = event["external_task_id"]
    config = {"configurable": {"thread_id": thread_id}}

    # Resume only a run that is paused on this request. A repeated or late event finds none.
    paused_on = [paused.value.get("request_id") for paused in graph.get_state(config).interrupts]
    if event["request_id"] not in paused_on:
        log.info("Ignored %s for %s: no run is paused on it", event["event"], event["request_id"])
        return

    # The event says what happened, not what the human answered. Read the request for that.
    request = cuehuman.get_request(event["request_id"])
    answer = {
        "status": request["status"],
        "choice": (request["result"] or {}).get("choice"),
        "comment": request["comment"],
    }
    result = graph.invoke(Command(resume=answer), config)
    log.info("Resumed %s after %s -> %s", thread_id, event["event"], result.get("outcome"))
