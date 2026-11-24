"""Starts one run and exits while it waits for the human.

    python start_run.py "replacement order 1042" customer@example.com
"""

import sys
import uuid

from dotenv import load_dotenv

load_dotenv()

from graph import build_graph  # noqa: E402  (after load_dotenv, so it sees the environment)


def main() -> None:
    order, customer_email = sys.argv[1], sys.argv[2]
    thread_id = f"order-{uuid.uuid4()}"
    config = {"configurable": {"thread_id": thread_id}}

    result = build_graph().invoke({"order": order, "customer_email": customer_email}, config)

    waiting = result.get("__interrupt__")
    print(f"Thread:  {thread_id}")
    print(f"Request: {result.get('request_id')}")
    print("Paused, waiting for the human." if waiting else f"Finished: {result.get('outcome')}")
    print(f"Check it later with: python show_run.py {thread_id}")


if __name__ == "__main__":
    main()
