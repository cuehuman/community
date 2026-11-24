# A tool that lets an agent ask a person and wait for the answer

`ask_human` is a LangChain tool. The agent calls it with a question and a list of options. The tool sends the question through CueHuman and returns the person's choice to the agent.

Use this when the answer is expected within a few minutes: the agent's run stays open while it waits. For a wait of hours or days, use [pause and resume](../pause-and-resume/).

This page first shows the code you add to your own agent, then how to run the complete example in this folder.

## How it works

1. The agent calls `ask_human(question, options)`.
2. The tool creates a CueHuman request, and CueHuman emails the person a link to the request form.
3. The tool waits until the person answers.
4. The tool returns the choice, and any comment, to the agent.
5. If nobody answers within the wait limit (10 minutes by default), the tool tells the agent not to act.

## Add it to your agent

### 1. Build the tool for one person

From `ask_human.py`:

```python
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
```

- **Your code chooses who is asked, not the model.** The address is fixed when the tool is built. The model sees only `question` and `options`.
- **A retried tool call does not ask twice.** The tool call's ID is sent as `external_task_id`, so a repeat returns the same request.

### 2. Send the question

From `ask_human.py`:

```python
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
```

### 3. Wait for the answer

From `ask_human.py`:

```python
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
```

No webhook is needed: the tool reads the request with `wait=25`, which CueHuman holds open until the person answers. A dropped connection does not end the wait: the tool asks again until the time runs out.

### 4. Give the tool to your agent

From `agent.py`:

```python
agent = create_agent(
    model=os.environ["MODEL"],
    tools=[make_ask_human(os.environ["APPROVER_EMAIL"]), issue_refund],
    system_prompt=(
        "You handle billing problems. Before any refund, call ask_human with the order, the amount and "
        'the reason, and the options ["Approve", "Reject"]. Issue the refund only if the person approves.'
    ),
)
```

## Run the complete example

| File | What it does |
|---|---|
| `ask_human.py` | `make_ask_human(email)`, which builds the tool |
| `agent.py` | An agent that must ask before it issues a refund |

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Fill in `.env`: your CueHuman agent key, the address of the person to ask, and a model with its provider's key. To use another provider, install its LangChain package and change `MODEL`.

```bash
python agent.py "Customer 8841 was double charged \$1,250.00 on order 1042. Please fix it."
```

The agent asks for approval, you answer from the email, and the agent finishes.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. The wait shows up as the length of the `ask_human` tool call.
