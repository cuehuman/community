"""A LangChain tool that asks one person a question through CueHuman and waits for the answer.

Reads CUEHUMAN_API_KEY from the environment.
"""

import os
import time
from typing import Annotated

import httpx
from langchain_core.tools import BaseTool, InjectedToolCallId, tool

API_URL = os.environ.get("CUEHUMAN_API_URL", "https://api.cuehuman.ai")
ENDED = {"completed", "expired", "canceled"}


def make_ask_human(email: str, max_wait_seconds: int = 600) -> BaseTool:
    """Builds the tool for one person. Your code picks who is asked; the model picks the question."""

    @tool
    def ask_human(question: str, options: list[str], tool_call_id: Annotated[str, InjectedToolCallId]) -> str:
        """Ask a person to choose one of the options, and wait for their answer.

        Use this before an action that needs a person's approval or decision.
        `question` is shown to the person as written, so make it complete and specific.
        `options` are the choices they pick from, for example ["Approve", "Reject"].
        """
        request = create_request(f"ask-human-{tool_call_id}", email, question, options, max_wait_seconds)
        request = wait_for_answer(request, max_wait_seconds)
        if request["status"] != "completed":
            return "The person did not answer in time. Do not carry out the action."
        answer = f"The person chose: {request['result']['choice']}."
        if request["comment"]:
            answer += f" Their comment: {request['comment']}"
        return answer

    return ask_human


def create_request(task_id: str, email: str, question: str, options: list[str], expires_in_seconds: int) -> dict:
    """Sends the question. The tool call's ID is the task ID, so a retried call does not ask twice."""
    response = _call(
        "POST",
        "/v1/requests",
        json={
            "external_task_id": task_id,
            "human": {"email": email},
            "type": "decision",
            "prompt": question,
            "schema": {"options": options},
            "allow_comment": True,
            # The request ends when the tool stops waiting, so no question is left open.
            "expires_in_seconds": max(60, expires_in_seconds),
        },
    )
    if response.status_code == 409:  # This tool call was sent before, and its request has ended.
        response = _call("GET", f"/v1/requests/{task_id}")
    response.raise_for_status()
    return response.json()


def wait_for_answer(request: dict, max_wait_seconds: int) -> dict:
    """Waits until the person answers, the request ends, or the time runs out."""
    deadline = time.monotonic() + max_wait_seconds
    while request["status"] not in ENDED and time.monotonic() < deadline:
        try:
            # One call stays open for up to 25 seconds, and returns at once when the person answers.
            response = _call("GET", f"/v1/requests/{request['request_id']}", params={"wait": 25})
        except httpx.TransportError:  # A dropped or timed-out connection. Ask again.
            time.sleep(5)
            continue
        if response.status_code == 429:  # Too many calls are waiting. Try again shortly.
            time.sleep(min(int(response.headers.get("Retry-After", "5")), 30))
            continue
        response.raise_for_status()
        request = response.json()
    return request


def _call(method: str, path: str, **kwargs) -> httpx.Response:
    headers = {"Authorization": f"Bearer {os.environ['CUEHUMAN_API_KEY']}"}
    for attempt in range(3):
        try:
            return httpx.request(method, f"{API_URL}{path}", headers=headers, timeout=40.0, **kwargs)
        except httpx.TransportError:  # A dropped or timed-out connection. Both calls are safe to repeat.
            if attempt == 2:
                raise
            time.sleep(2**attempt)
