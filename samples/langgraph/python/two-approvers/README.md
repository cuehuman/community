# An action that needs every approver to say yes

An approval that goes to several people at once. Each approver gets their own request, each answer resumes its own branch of the graph, and the action runs only when everyone has approved.

It builds on [pause and resume](../pause-and-resume/). This page first shows the code you add to your own graph, then how to run the complete example in this folder.

## How it works

1. One node creates a request for each approver.
2. The graph then opens one branch for each approver, side by side, and every branch pauses.
3. When an approver answers, CueHuman calls your webhook. The endpoint finds the branch that is paused on that request and resumes only that branch.
4. The run stays paused until every branch has an answer: an approval, a rejection, or an expiry.
5. The last node decides. Every approver must have approved, or nothing is done.

## Add it to your graph

### 1. Create one request for each approver

From `graph.py`:

```python
def ask_approvers(state: State, config: RunnableConfig) -> State:
    """Creates one request for each approver. Its own node, so it is not repeated when the run resumes."""
    thread_id = config["configurable"]["thread_id"]
    requests = {}
    for number, email in enumerate(state["approver_emails"], start=1):
        request = cuehuman.create_request(
            external_task_id=f"{thread_id}:{number}",  # Starts with the thread ID, so the webhook finds this run.
            email=email,
            prompt=f"An AI agent wants to: {state['action']}. Every approver must agree. Do you approve?",
            options=[APPROVE, REJECT],
        )
        requests[email] = request["request_id"]
    return {"requests": requests}
```

Each request's task ID is the thread ID and the approver's number, so the webhook endpoint can find the run from any of them.

### 2. Open one branch for each approver, and pause in it

From `graph.py`:

```python
def one_branch_for_each_approver(state: State) -> list[Send]:
    return [Send("wait_for_approver", {"email": email, "request_id": request_id}) for email, request_id in state["requests"].items()]
```

```python
def wait_for_approver(branch: dict) -> State:
    """Pauses this approver's branch until the webhook endpoint resumes it with their answer."""
    answer = interrupt({"request_id": branch["request_id"]})
    return {"answers": {branch["email"]: answer}}
```

`Send` starts a copy of the node for each approver. The branches write to the same `answers` value, so the graph's state merges what they return.

### 3. Resume only the branch that was answered

From `webhook_server.py`:

```python
def resume_run(event: dict) -> None:
    thread_id = event["external_task_id"].split(":", 1)[0]
    config = {"configurable": {"thread_id": thread_id}}

    # Find the branch that is paused on this request. A repeated or late event finds none.
    paused = [p for p in graph.get_state(config).interrupts if p.value.get("request_id") == event["request_id"]]
    if not paused:
        log.info("Ignored %s for %s: no run is paused on it", event["event"], event["request_id"])
        return

    # The event says what happened, not what the human answered. Read the request for that.
    request = cuehuman.get_request(event["request_id"])
    answer = {
        "status": request["status"],
        "choice": (request["result"] or {}).get("choice"),
        "comment": request["comment"],
    }
    # Resume only that branch, by the ID of its pause. The other branches keep waiting.
    result = graph.invoke(Command(resume={paused[0].id: answer}), config)
    still_waiting = len(graph.get_state(config).interrupts)
    if still_waiting:
        log.info("Resumed one branch of %s after %s; %d still waiting", thread_id, event["event"], still_waiting)
    else:
        log.info("Resumed %s after %s -> %s", thread_id, event["event"], result.get("outcome"))
```

Each pause has an ID. Resuming with that ID answers one branch and leaves the others waiting.

### 4. Decide once everyone has answered

From `graph.py`:

```python
def decide(state: State) -> State:
    """Runs once every branch has an answer. The action needs a yes from every approver."""
    not_approved = [email for email, answer in state["answers"].items() if answer["choice"] != APPROVE]
    if not not_approved:
        # Replace this with the real action.
        return {"outcome": f"Approved by all {len(state['answers'])} approvers. Carried out: {state['action']}"}
    reasons = []
    for email in not_approved:
        answer = state["answers"][email]
        reasons.append(f"{email} rejected ({answer['comment'] or 'no comment'})" if answer["choice"] == REJECT else f"{email} did not answer")
    return {"outcome": "Not approved: " + "; ".join(reasons) + ". Nothing was done."}
```

## Run the complete example

| File | What it does |
|---|---|
| `graph.py` | The graph: ask every approver, wait in one branch each, then decide |
| `webhook_server.py` | The webhook endpoint that resumes the branch that was answered |
| `cuehuman.py` | The CueHuman calls: create a request, read it, check a webhook's signature |
| `start_run.py` | Starts a run and exits while it waits |
| `show_run.py` | Shows how many approvers have answered |

### Set up

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

In the CueHuman Developer Portal:

1. Create an agent and copy its test key into `CUEHUMAN_API_KEY`.
2. Create a webhook profile that points at `https://<your-host>/webhooks/cuehuman`, with signing on. Subscribe it to `request.human_submitted`, `request.expired` and `request.canceled`.
3. Put the profile's name in `CUEHUMAN_WEBHOOK_NAME` and its signing secret in `CUEHUMAN_WEBHOOK_SECRET`.

CueHuman must be able to reach the endpoint over HTTPS. On your own machine, use a tunnel such as `cloudflared` or `ngrok` and give the profile the tunnel's address.

### Run it

Start the webhook endpoint:

```bash
uvicorn webhook_server:app --port 8000
```

In a second terminal, start a run with two or more approvers. With a test key, every address must belong to a member of your organization.

```bash
python start_run.py "Wire \$25,000.00 to Example Company" first@example.com second@example.com
```

Answer the emails one at a time. The endpoint logs each answer:

```
Resumed one branch of approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted; 1 still waiting
Resumed approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Approved by all 2 approvers. Carried out: Wire $25,000.00 to Example Company
```

Check a run at any time:

```bash
python show_run.py approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

## Before production

- Use a Postgres checkpointer in place of SQLite.
- Resume one run at a time. If two answers for the same run can arrive together, queue them.
- A rejection does not end the wait for the others. To stop early, cancel the open requests when one approver rejects.
- Switch to a `cue_live_` key to reach people outside your organization.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. Each run then appears in LangSmith as one trace that ends at the pause, and one more for each resume.
