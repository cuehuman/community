"""Starts one run on the server and returns when it pauses for the human.

    python start_run.py "Refund order 1042 for $1,250.00" approver@example.com
"""

import os
import sys

from dotenv import load_dotenv
from langgraph_sdk import get_sync_client

load_dotenv()


def main() -> None:
    action, approver_email = sys.argv[1], sys.argv[2]
    # LANGGRAPH_URL is your deployment's address, or http://localhost:2024 for `langgraph dev`.
    client = get_sync_client(url=os.environ["LANGGRAPH_URL"], api_key=os.environ.get("LANGSMITH_API_KEY"))

    thread = client.threads.create()
    result = client.runs.wait(thread["thread_id"], "approval", input={"action": action, "approver_email": approver_email})

    print(f"Thread:  {thread['thread_id']}")
    print(f"Request: {result.get('request_id')}")
    print("Paused, waiting for the human." if "__interrupt__" in result else f"Finished: {result.get('outcome')}")
    print(f"Check it later with: python show_run.py {thread['thread_id']}")


if __name__ == "__main__":
    main()
