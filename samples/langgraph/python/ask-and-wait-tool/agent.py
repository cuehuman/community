"""An agent that must ask a person before it issues a refund.

    python agent.py "Customer 8841 was double charged $1,250.00 on order 1042. Please fix it."
"""

import os
import sys

from dotenv import load_dotenv

load_dotenv()

from langchain.agents import create_agent  # noqa: E402  (after load_dotenv, so it sees the environment)
from langchain_core.tools import tool  # noqa: E402

from ask_human import make_ask_human  # noqa: E402


@tool
def issue_refund(order_id: str, amount_usd: float) -> str:
    """Refunds an order. Only call this after a person has approved the refund."""
    return f"Refunded ${amount_usd:,.2f} on order {order_id}."  # Replace with the real action.


agent = create_agent(
    model=os.environ["MODEL"],
    tools=[make_ask_human(os.environ["APPROVER_EMAIL"]), issue_refund],
    system_prompt=(
        "You handle billing problems. Before any refund, call ask_human with the order, the amount and "
        'the reason, and the options ["Approve", "Reject"]. Issue the refund only if the person approves.'
    ),
)

if __name__ == "__main__":
    result = agent.invoke({"messages": [{"role": "user", "content": sys.argv[1]}]})
    print(result["messages"][-1].content)
