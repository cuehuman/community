"""An approval that does not wait forever: remind the approver once, then ask a backup.

    ask_human -> wait_for_human -> carry_out            (approved)
                                -> stop                 (rejected, canceled, or nobody answered)
                                -> remind -> wait_for_human      (first request expired)
                                -> escalate -> wait_for_human    (the reminder expired too)
"""

import os
import sqlite3
from typing import Literal, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

import cuehuman

APPROVE, REJECT = "Approve", "Reject"
# How long each person has to answer, in seconds. One day unless ANSWER_WITHIN_SECONDS says otherwise.
ANSWER_WITHIN = int(os.environ.get("ANSWER_WITHIN_SECONDS", 86400))


class State(TypedDict, total=False):
    action: str  # What the agent wants to do, in words the approver will read.
    approver_email: str
    backup_email: str
    request_id: str  # The CueHuman request this run is waiting on.
    stage: Literal["first", "reminder", "backup"]  # Which request that is.
    answer: dict  # What the webhook endpoint resumed the run with.
    outcome: str


def ask_human(state: State, config: RunnableConfig) -> State:
    """Asks the approver. The task ID starts with the thread ID, so the webhook can find this run."""
    request = cuehuman.create_request(
        external_task_id=f"{config['configurable']['thread_id']}:first",
        email=state["approver_email"],
        prompt=f"An AI agent wants to: {state['action']}. Do you approve?",
        options=[APPROVE, REJECT],
        expires_in_seconds=ANSWER_WITHIN,
    )
    return {"request_id": request["request_id"], "stage": "first"}


def wait_for_human(state: State) -> State:
    """Pauses the run until the webhook endpoint resumes it: with an answer, or with none."""
    answer = interrupt({"request_id": state["request_id"]})
    return {"answer": answer}


def route(state: State) -> Literal["carry_out", "stop", "remind", "escalate"]:
    answer = state["answer"]
    if answer["choice"] == APPROVE:
        return "carry_out"
    if answer["choice"] == REJECT or answer["status"] != "expired":
        return "stop"
    # Nobody answered in time. Remind the approver once, then ask the backup once.
    return {"first": "remind", "reminder": "escalate", "backup": "stop"}[state["stage"]]


def remind(state: State, config: RunnableConfig) -> State:
    """Sends the expired request to the same approver again. CueHuman calls this a reissue."""
    request = cuehuman.reissue_request(
        state["request_id"],
        external_task_id=f"{config['configurable']['thread_id']}:reminder",
        expires_in_seconds=ANSWER_WITHIN,
    )
    return {"request_id": request["request_id"], "stage": "reminder"}


def escalate(state: State, config: RunnableConfig) -> State:
    """Asks the backup approver, with a new request."""
    request = cuehuman.create_request(
        external_task_id=f"{config['configurable']['thread_id']}:backup",
        email=state["backup_email"],
        prompt=f"An AI agent wants to: {state['action']}. The first approver did not answer. Do you approve?",
        options=[APPROVE, REJECT],
        expires_in_seconds=ANSWER_WITHIN,
    )
    return {"request_id": request["request_id"], "stage": "backup"}


def carry_out(state: State) -> State:
    # Replace this with the real action.
    by = "the backup approver" if state["stage"] == "backup" else "the approver"
    return {"outcome": f"Approved by {by}. Carried out: {state['action']}"}


def stop(state: State) -> State:
    answer = state["answer"]
    if answer["choice"] == REJECT:
        return {"outcome": f"Rejected. Comment: {answer['comment'] or 'none'}"}
    if answer["status"] == "expired":
        return {"outcome": "Nobody answered: not the approver, after a reminder, nor the backup. Nothing was done."}
    return {"outcome": f"No answer (request {answer['status']}). Nothing was done."}


def build_graph(checkpoint_path: str = "checkpoints.sqlite"):
    """Builds the graph with a SQLite checkpointer, so a paused run survives a restart.

    `start_run.py` and `webhook_server.py` both open the same file. Use Postgres in production.
    """
    builder = StateGraph(State)
    builder.add_node("ask_human", ask_human)
    builder.add_node("wait_for_human", wait_for_human)
    builder.add_node("remind", remind)
    builder.add_node("escalate", escalate)
    builder.add_node("carry_out", carry_out)
    builder.add_node("stop", stop)
    builder.add_edge(START, "ask_human")
    builder.add_edge("ask_human", "wait_for_human")
    builder.add_conditional_edges("wait_for_human", route)
    builder.add_edge("remind", "wait_for_human")
    builder.add_edge("escalate", "wait_for_human")
    builder.add_edge("carry_out", END)
    builder.add_edge("stop", END)
    connection = sqlite3.connect(checkpoint_path, check_same_thread=False)
    return builder.compile(checkpointer=SqliteSaver(connection))
