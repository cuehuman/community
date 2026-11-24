"""A workflow that pauses to ask a person for details it does not have.

    ask_for_details  ->  wait_for_details  ->  ship_order   (the person filled in the form)
                                           ->  stop         (no answer)
"""

import sqlite3
from typing import Literal, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

import cuehuman

# The form the person fills in. CueHuman checks each answer against its field before it accepts the form.
DELIVERY_FIELDS = [
    {"name": "street", "type": "text", "label": "Street address", "required": True},
    {"name": "city", "type": "text", "label": "City", "required": True},
    {"name": "postal_code", "type": "text", "label": "ZIP or postal code", "required": True, "max_length": 12},
    {"name": "speed", "type": "select", "label": "Delivery speed", "options": ["Standard", "Express"], "required": True},
    {"name": "contact_email", "type": "text", "label": "Email for delivery updates", "validation": "email"},
    {"name": "notes", "type": "textarea", "label": "Notes for the driver", "max_length": 500},
]


class State(TypedDict, total=False):
    order: str  # What is being shipped, in words the person will read.
    customer_email: str
    request_id: str  # The CueHuman request this run is waiting on.
    answer: dict  # What the webhook endpoint resumed the run with.
    outcome: str


def ask_for_details(state: State, config: RunnableConfig) -> State:
    """Creates the form request. Its own node, so it is not repeated when the run resumes."""
    request = cuehuman.create_form_request(
        external_task_id=config["configurable"]["thread_id"],  # How the webhook finds this run.
        email=state["customer_email"],
        prompt=f"We are ready to ship {state['order']}. Where should we send it?",
        fields=DELIVERY_FIELDS,
    )
    return {"request_id": request["request_id"]}


def wait_for_details(state: State) -> State:
    """Pauses the run until the webhook endpoint resumes it with what the person entered."""
    answer = interrupt({"request_id": state["request_id"]})
    return {"answer": answer}


def route(state: State) -> Literal["ship_order", "stop"]:
    return "ship_order" if state["answer"]["values"] else "stop"


def ship_order(state: State) -> State:
    # Replace this with the real action. Each answer is under its field's name.
    details = state["answer"]["values"]
    address = f"{details['street']}, {details['city']} {details['postal_code']}"
    return {"outcome": f"Shipping {state['order']} to {address} by {details['speed']} delivery."}


def stop(state: State) -> State:
    return {"outcome": f"No details (request {state['answer']['status']}). Nothing was shipped."}


def build_graph(checkpoint_path: str = "checkpoints.sqlite"):
    """Builds the graph with a SQLite checkpointer, so a paused run survives a restart.

    `start_run.py` and `webhook_server.py` both open the same file. Use Postgres in production.
    """
    builder = StateGraph(State)
    builder.add_node("ask_for_details", ask_for_details)
    builder.add_node("wait_for_details", wait_for_details)
    builder.add_node("ship_order", ship_order)
    builder.add_node("stop", stop)
    builder.add_edge(START, "ask_for_details")
    builder.add_edge("ask_for_details", "wait_for_details")
    builder.add_conditional_edges("wait_for_details", route)
    builder.add_edge("ship_order", END)
    builder.add_edge("stop", END)
    connection = sqlite3.connect(checkpoint_path, check_same_thread=False)
    return builder.compile(checkpointer=SqliteSaver(connection))
