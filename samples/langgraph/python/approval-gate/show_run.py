"""Shows where a run is.

    python show_run.py refund-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
"""

import sys

from dotenv import load_dotenv

load_dotenv()

from agent import agent  # noqa: E402


def main() -> None:
    snapshot = agent.get_state({"configurable": {"thread_id": sys.argv[1]}})
    if not snapshot.values:
        print("No run with that thread ID.")
    elif snapshot.interrupts:
        for paused in snapshot.interrupts:
            print(f"Paused, waiting for a person: {paused.value['description']}")
    else:
        print(f"Finished: {snapshot.values['messages'][-1].text}")


if __name__ == "__main__":
    main()
