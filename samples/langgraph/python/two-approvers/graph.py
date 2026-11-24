"""An action that needs every approver to say yes. Each is asked at the same time, in a separate request.

    ask_approvers  ->  wait_for_approver (one for each approver, side by side)  ->  decide
"""

import operator
import sqlite3
from typing import Annotated, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send, interrupt

import cuehuman

APPROVE, REJECT = "Approve", "Reject"


class State(TypedDict, total=False):
    action: str  # What the agent wants to do, in words the approvers will read.
    approver_emails: list[str]
    requests: dict[str, str]  # Each approver's email, and the CueHuman request sent to them.
    # Each approver's email, and their answer. The branches run side by side, so their answers are merged.
    answers: Annotated[dict[str, dict], operator.or_]
    outcome: str


def ask_approvers(state: State, config: RunnableConfig) -> State:
    """Creates one request for each approver. Its own node, so it is not repeated when the run resumes."""
    thread_id = config["configurable"]["thread_id"]
    requests = {}
    for number, email in enumerate(state["approver_emails"], start=1):
        request = cuehuman.create_request(
            external_task_id=f"{thread_id}:{number}",  # Starts with the thread ID, so the webhook finds this run.
            email=email,
            prompt=f"An AI agent wants to: {state['action']}. Every approver must agree. Do you approve?",
            options=[APPROVE, REJECT],
        )
        requests[email] = request["request_id"]
    return {"requests": requests}


def one_branch_for_each_approver(state: State) -> list[Send]:
    return [Send("wait_for_approver", {"email": email, "request_id": request_id}) for email, request_id in state["requests"].items()]


def wait_for_approver(branch: dict) -> State:
    """Pauses this approver's branch until the webhook endpoint resumes it with their answer."""
    answer = interrupt({"request_id": branch["request_id"]})
    return {"answers": {branch["email"]: answer}}


def decide(state: State) -> State:
    """Runs once every branch has an answer. The action needs a yes from every approver."""
    not_approved = [email for email, answer in state["answers"].items() if answer["choice"] != APPROVE]
    if not not_approved:
        # Replace this with the real action.
        return {"outcome": f"Approved by all {len(state['answers'])} approvers. Carried out: {state['action']}"}
    reasons = []
    for email in not_approved:
        answer = state["answers"][email]
        reasons.append(f"{email} rejected ({answer['comment'] or 'no comment'})" if answer["choice"] == REJECT else f"{email} did not answer")
    return {"outcome": "Not approved: " + "; ".join(reasons) + ". Nothing was done."}


def build_graph(checkpoint_path: str = "checkpoints.sqlite"):
    """Builds the graph with a SQLite checkpointer, so a paused run survives a restart.

    `start_run.py` and `webhook_server.py` both open the same file. Use Postgres in production.
    """
    builder = StateGraph(State)
    builder.add_node("ask_approvers", ask_approvers)
    builder.add_node("wait_for_approver", wait_for_approver)
    builder.add_node("decide", decide)
    builder.add_edge(START, "ask_approvers")
    builder.add_conditional_edges("ask_approvers", one_branch_for_each_approver, ["wait_for_approver"])
    builder.add_edge("wait_for_approver", "decide")
    builder.add_edge("decide", END)
    connection = sqlite3.connect(checkpoint_path, check_same_thread=False)
    return builder.compile(checkpointer=SqliteSaver(connection))
