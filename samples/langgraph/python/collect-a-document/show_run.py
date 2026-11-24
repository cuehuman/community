"""Shows where a run is.

    python show_run.py claim-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
"""

import sys

from dotenv import load_dotenv

load_dotenv()

from graph import build_graph  # noqa: E402


def main() -> None:
    snapshot = build_graph().get_state({"configurable": {"thread_id": sys.argv[1]}})
    if not snapshot.values:
        print("No run with that thread ID.")
    elif snapshot.next:
        print(f"Paused at {snapshot.next[0]}, waiting on request {snapshot.values.get('request_id')}.")
    else:
        print(f"Finished: {snapshot.values.get('outcome')}")


if __name__ == "__main__":
    main()
