"""Starts one run and exits while it waits for the approvers.

    python start_run.py "Wire $25,000.00 to Example Company" first@example.com second@example.com
"""

import sys
import uuid

from dotenv import load_dotenv

load_dotenv()

from graph import build_graph  # noqa: E402  (after load_dotenv, so it sees the environment)


def main() -> None:
    action, approver_emails = sys.argv[1], sys.argv[2:]
    thread_id = f"approval-{uuid.uuid4()}"
    config = {"configurable": {"thread_id": thread_id}}

    result = build_graph().invoke({"action": action, "approver_emails": approver_emails}, config)

    print(f"Thread: {thread_id}")
    waiting = len(result.get("__interrupt__", []))
    print(f"Paused, waiting for {waiting} approvers." if waiting else f"Finished: {result.get('outcome')}")
    print(f"Check it later with: python show_run.py {thread_id}")


if __name__ == "__main__":
    main()
