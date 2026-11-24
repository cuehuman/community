"""Starts one run and exits while it waits for the person.

    python start_run.py "Customer 8841 was double charged $1,250.00 on order 1042. Please fix it."
"""

import sys
import uuid

from dotenv import load_dotenv

load_dotenv()

from agent import advance  # noqa: E402  (after load_dotenv, so it sees the environment)


def main() -> None:
    thread_id = f"refund-{uuid.uuid4()}"
    result = advance({"messages": [{"role": "user", "content": sys.argv[1]}]}, thread_id)

    print(f"Thread: {thread_id}")
    if result.interrupts:
        for paused in result.interrupts:
            print(f"Paused, waiting for a person: {paused.value['description']}")
        print(f"Check it later with: python show_run.py {thread_id}")
    else:
        print(f"Finished: {result.value['messages'][-1].text}")


if __name__ == "__main__":
    main()
