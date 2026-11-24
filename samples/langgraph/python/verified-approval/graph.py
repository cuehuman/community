"""A high-risk approval: the approver proves they hold the address, and the answer's receipt is checked.

    ask_human  ->  wait_for_human  ->  check_proof  ->  carry_out   (approved, verified, receipt valid)
                                                    ->  stop        (anything else)
"""

import sqlite3
from typing import Literal, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

import cuehuman

APPROVE, REJECT = "Approve", "Reject"


class State(TypedDict, total=False):
    action: str  # What the agent wants to do, in words the approver will read.
    approver_email: str
    request_id: str  # The CueHuman request this run is waiting on.
    answer: dict  # What the webhook endpoint resumed the run with.
    proof: dict  # Evidence of the approval, kept with the run.
    refused: str  # Why the approval could not be relied on.
    outcome: str


def ask_human(state: State, config: RunnableConfig) -> State:
    """Creates the request, with verification on. Its own node, so it is not repeated when the run resumes."""
    request = cuehuman.create_request(
        external_task_id=config["configurable"]["thread_id"],  # How the webhook finds this run.
        email=state["approver_email"],
        prompt=f"An AI agent wants to: {state['action']}. Do you approve?",
        options=[APPROVE, REJECT],
    )
    return {"request_id": request["request_id"]}


def wait_for_human(state: State) -> State:
    """Pauses the run until the webhook endpoint resumes it with the human's answer."""
    answer = interrupt({"request_id": state["request_id"]})
    return {"answer": answer}


def check_proof(state: State) -> State:
    """Before acting on an approval, reads the request again and checks what CueHuman recorded."""
    if state["answer"]["choice"] != APPROVE:
        return {}
    request = cuehuman.get_request(state["request_id"])
    verification = request["verification"] or {}
    if (request["result"] or {}).get("choice") != APPROVE:
        return {"refused": "the recorded answer is not an approval"}
    if verification.get("status") != "verified":
        return {"refused": "the approver did not verify their address"}
    if not cuehuman.verify_receipt(request):
        return {"refused": "the receipt does not match the answer"}
    # Keep the evidence: who verified, when, and the signed receipt. Store the request too if you need it later.
    proof = {
        "verified_address": verification["verified_contact"]["value"],
        "verified_at": verification["verified_at"],
        "receipt": request["receipt"],
    }
    return {"proof": proof}


def route(state: State) -> Literal["carry_out", "stop"]:
    return "carry_out" if state.get("proof") else "stop"


def carry_out(state: State) -> State:
    # Replace this with the real action.
    proof = state["proof"]
    return {"outcome": f"Approved by {proof['verified_address']}, verified at {proof['verified_at']}. Carried out: {state['action']}"}


def stop(state: State) -> State:
    answer = state["answer"]
    if state.get("refused"):
        return {"outcome": f"Not carried out: {state['refused']}."}
    if answer["choice"] == REJECT:
        return {"outcome": f"Rejected by the approver. Comment: {answer['comment'] or 'none'}"}
    return {"outcome": f"No answer (request {answer['status']}). Nothing was done."}


def build_graph(checkpoint_path: str = "checkpoints.sqlite"):
    """Builds the graph with a SQLite checkpointer, so a paused run survives a restart.

    `start_run.py` and `webhook_server.py` both open the same file. Use Postgres in production.
    """
    builder = StateGraph(State)
    builder.add_node("ask_human", ask_human)
    builder.add_node("wait_for_human", wait_for_human)
    builder.add_node("check_proof", check_proof)
    builder.add_node("carry_out", carry_out)
    builder.add_node("stop", stop)
    builder.add_edge(START, "ask_human")
    builder.add_edge("ask_human", "wait_for_human")
    builder.add_edge("wait_for_human", "check_proof")
    builder.add_conditional_edges("check_proof", route)
    builder.add_edge("carry_out", END)
    builder.add_edge("stop", END)
    connection = sqlite3.connect(checkpoint_path, check_same_thread=False)
    return builder.compile(checkpointer=SqliteSaver(connection))
