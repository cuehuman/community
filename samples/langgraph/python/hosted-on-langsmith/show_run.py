"""Shows where a run is.

    python show_run.py 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
"""

import os
import sys

from dotenv import load_dotenv
from langgraph_sdk import get_sync_client

load_dotenv()


def main() -> None:
    client = get_sync_client(url=os.environ["LANGGRAPH_URL"], api_key=os.environ.get("LANGSMITH_API_KEY"))
    state = client.threads.get_state(sys.argv[1])
    if state["next"]:
        print(f"Paused at {state['next'][0]}, waiting on request {state['values'].get('request_id')}.")
    else:
        print(f"Finished: {state['values'].get('outcome')}")


if __name__ == "__main__":
    main()
