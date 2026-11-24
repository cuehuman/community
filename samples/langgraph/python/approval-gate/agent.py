"""An agent whose refund tool cannot run until a person approves that exact call.

LangChain's human-in-the-loop middleware pauses the agent before `issue_refund` runs.
`advance` asks a person about each paused call through CueHuman, and the webhook
endpoint (webhook_server.py) resumes the run with the answer.
"""

import os
import sqlite3

from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langchain_core.tools import tool
from langgraph.checkpoint.sqlite import SqliteSaver

import cuehuman

APPROVE, REJECT = "Approve", "Reject"


@tool
def issue_refund(order_id: str, amount_usd: float) -> str:
    """Refunds an order."""
    return f"Refunded ${amount_usd:,.2f} on order {order_id}."  # Replace with the real action.


def describe_refund(tool_call, state, runtime) -> str:
    """What the approver reads: the exact call the agent wants to make."""
    args = tool_call["args"]
    return f"An AI agent wants to refund ${args['amount_usd']:,.2f} on order {args['order_id']}. Do you approve?"


agent = create_agent(
    model=os.environ["MODEL"],
    tools=[issue_refund],
    system_prompt="You handle billing problems. Refund an order when the customer is owed the money.",
    middleware=[
        HumanInTheLoopMiddleware(
            interrupt_on={"issue_refund": {"allowed_decisions": ["approve", "reject"], "description": describe_refund}},
            interrupt_mode="per_call",  # One pause, and one question, for each call.
        )
    ],
    # A SQLite checkpointer, so a paused run survives a restart. Use Postgres in production.
    checkpointer=SqliteSaver(sqlite3.connect("checkpoints.sqlite", check_same_thread=False)),
)


def advance(agent_input, thread_id: str):
    """Runs the agent until it finishes or pauses, then asks a person about each paused call."""
    result = agent.invoke(agent_input, {"configurable": {"thread_id": thread_id}}, version="v2")
    ask_about_paused_calls(thread_id)
    return result


def ask_about_paused_calls(thread_id: str) -> None:
    """Creates one CueHuman request for each tool call the run is paused on. Safe to call again."""
    for paused in agent.get_state({"configurable": {"thread_id": thread_id}}).interrupts:
        cuehuman.create_request(
            external_task_id=f"{thread_id}:{paused.id}",  # How the webhook finds the run and the call.
            email=os.environ["APPROVER_EMAIL"],
            prompt=paused.value["description"],
            options=[APPROVE, REJECT],
        )
