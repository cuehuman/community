"""A workflow that pauses until a person uploads the documents it needs.

    ask_for_documents  ->  wait_for_documents  ->  save_documents   (the person uploaded files)
                                               ->  stop             (no answer)
"""

import sqlite3
from typing import Literal, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

import cuehuman

CATEGORIES = ["Receipt", "Photo of the damage"]


class State(TypedDict, total=False):
    claim: str  # What the documents are for, in words the person will read.
    customer_email: str
    request_id: str  # The CueHuman request this run is waiting on.
    answer: dict  # What the webhook endpoint resumed the run with.
    outcome: str


def ask_for_documents(state: State, config: RunnableConfig) -> State:
    """Creates the file request. Its own node, so it is not repeated when the run resumes."""
    request = cuehuman.create_file_request(
        external_task_id=config["configurable"]["thread_id"],  # How the webhook finds this run.
        email=state["customer_email"],
        prompt=f"To finish {state['claim']}, please upload your receipt and a photo of the damage.",
        categories=CATEGORIES,
    )
    return {"request_id": request["request_id"]}


def wait_for_documents(state: State) -> State:
    """Pauses the run until the webhook endpoint resumes it with the list of uploaded files."""
    answer = interrupt({"request_id": state["request_id"]})
    return {"answer": answer}


def route(state: State) -> Literal["save_documents", "stop"]:
    return "save_documents" if state["answer"]["files"] else "stop"


def save_documents(state: State, config: RunnableConfig) -> State:
    """Downloads the files into a folder for this run. Replace this with your own storage."""
    folder = f"received/{config['configurable']['thread_id']}"
    saved = cuehuman.download_files(state["request_id"], folder)
    labels = ", ".join(f"{file['name']} ({file['category']})" for file in state["answer"]["files"])
    return {"outcome": f"Saved {len(saved)} files to {folder}: {labels}"}


def stop(state: State) -> State:
    return {"outcome": f"No documents (request {state['answer']['status']}). The claim was left open."}


def build_graph(checkpoint_path: str = "checkpoints.sqlite"):
    """Builds the graph with a SQLite checkpointer, so a paused run survives a restart.

    `start_run.py` and `webhook_server.py` both open the same file. Use Postgres in production.
    """
    builder = StateGraph(State)
    builder.add_node("ask_for_documents", ask_for_documents)
    builder.add_node("wait_for_documents", wait_for_documents)
    builder.add_node("save_documents", save_documents)
    builder.add_node("stop", stop)
    builder.add_edge(START, "ask_for_documents")
    builder.add_edge("ask_for_documents", "wait_for_documents")
    builder.add_conditional_edges("wait_for_documents", route)
    builder.add_edge("save_documents", END)
    builder.add_edge("stop", END)
    connection = sqlite3.connect(checkpoint_path, check_same_thread=False)
    return builder.compile(checkpointer=SqliteSaver(connection))
