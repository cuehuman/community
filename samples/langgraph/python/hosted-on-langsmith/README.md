# An approval on a LangGraph server, such as a deployment on LangSmith

The [pause and resume](../pause-and-resume/) approval, for a graph that a LangGraph server runs: a deployment on LangSmith, or the local dev server. The server saves the runs, and the webhook endpoint is a route added to the same server.

This page first shows the code you add to your own project, then how to run the complete example in this folder.

## How it works

1. A client starts a run on the server. The graph creates the CueHuman request, with the server's thread ID as the task ID, and pauses.
2. The human answers, and CueHuman calls the server's `/webhooks/cuehuman` route.
3. The route checks the signature, reads the request for the answer, and resumes the thread through the server's own API.
4. The server continues the run, on whichever machine it has free.

## Add it to your project

### 1. Name the graph and the webhook route

`langgraph.json` tells the server what to load. `graphs` names the graph, and `http` adds your own routes beside the server's API.

```json
{
  "dependencies": ["."],
  "graphs": {
    "approval": "./graph.py:graph"
  },
  "http": {
    "app": "./webhook.py:app"
  },
  "env": ".env"
}
```

### 2. Compile the graph with no checkpointer

The nodes are the ones from pause and resume. The server saves each run, so the graph does not bring its own storage. From `graph.py`:

```python
builder = StateGraph(State)
```

### 3. Resume the thread from the webhook route

From `webhook.py`:

```python
async def resume_run(event: dict) -> None:
    client = get_client()  # With no address, this reaches the server it is running in.
    thread_id = event["external_task_id"]

    # Resume only a run that is paused on this request. A repeated or late event finds none.
    paused_on = [paused["value"].get("request_id") for paused in await paused_at(client, thread_id)]
    if event["request_id"] not in paused_on:
        log.info("Ignored %s for %s: no run is paused on it", event["event"], event["request_id"])
        return

    # The event says what happened, not what the human answered. Read the request for that.
    request = await asyncio.to_thread(cuehuman.get_request, event["request_id"])
    answer = {
        "status": request["status"],
        "choice": (request["result"] or {}).get("choice"),
        "comment": request["comment"],
    }
    result = await client.runs.wait(thread_id, ASSISTANT, command={"resume": answer})
    log.info("Resumed %s after %s -> %s", thread_id, event["event"], result.get("outcome"))
```

- **`get_client()` with no address reaches the server the route is running in.** No address or key is needed inside the server.
- **A resume is a new run on the same thread,** with the answer as its `resume` command. The server picks the run up where it paused.
- **The task ID is the server's thread ID,** so the event leads straight to the thread. An event for anything else finds no paused run and is ignored.

### 4. Start a run from a client

From `start_run.py`:

```python
def main() -> None:
    action, approver_email = sys.argv[1], sys.argv[2]
    # LANGGRAPH_URL is your deployment's address, or http://localhost:2024 for `langgraph dev`.
    client = get_sync_client(url=os.environ["LANGGRAPH_URL"], api_key=os.environ.get("LANGSMITH_API_KEY"))

    thread = client.threads.create()
    result = client.runs.wait(thread["thread_id"], "approval", input={"action": action, "approver_email": approver_email})

    # When the run pauses, the server returns the pause: what the graph gave `interrupt()`.
    paused = result.get("__interrupt__")

    print(f"Thread:  {thread['thread_id']}")
    if paused:
        print(f"Request: {paused[0]['value']['request_id']}")
        print("Paused, waiting for the human.")
    else:
        print(f"Finished: {result.get('outcome')}")
    print(f"Check it later with: python show_run.py {thread['thread_id']}")
```

## Run the complete example

| File | What it does |
|---|---|
| `graph.py` | The approval graph, compiled for a LangGraph server |
| `webhook.py` | The webhook route added to the server |
| `cuehuman.py` | The CueHuman calls: create a request, read it, check a webhook's signature |
| `start_run.py` | Starts a run on the server |
| `show_run.py` | Shows where a run is |
| `langgraph.json` | Names the graph and the webhook route for the server |

### Set up

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt "langgraph-cli[inmem]"
cp .env.example .env
```

In the CueHuman Developer Portal:

1. Create an agent and copy its test key into `CUEHUMAN_API_KEY`.
2. Create a webhook profile that points at `https://<your-server>/webhooks/cuehuman`, with signing on. Subscribe it to `request.human_submitted`, `request.expired` and `request.canceled`.
3. Put the profile's name in `CUEHUMAN_WEBHOOK_NAME` and its signing secret in `CUEHUMAN_WEBHOOK_SECRET`.

CueHuman must be able to reach the endpoint over HTTPS. On your own machine, use a tunnel such as `cloudflared` or `ngrok` and give the profile the tunnel's address.

### Run it on your machine

Start the LangGraph dev server, which listens on port 2024:

```bash
langgraph dev --no-browser
```

In a second terminal, start a run. With a test key, the address must belong to a member of your organization.

```bash
python start_run.py "Refund order 1042 for \$1,250.00" approver@example.com
```

Open the email and answer. The server logs the resume:

```
Resumed 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Approved. Carried out: Refund order 1042 for $1,250.00
```

Check a run at any time:

```bash
python show_run.py 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

### Deploy it to LangSmith

Deploy this folder as you would any LangGraph app, with the values from `.env` set as the deployment's environment variables. Then:

- Set `LANGGRAPH_URL` to the deployment's address, for the scripts.
- Point the webhook profile at `https://<your-deployment>/webhooks/cuehuman`.
- A deployment checks an API key on the calls it receives. Add a custom header to the webhook profile, `x-api-key` with a LangSmith API key, so CueHuman's calls are let in.

This sample was tested on the local dev server. It has not been deployed to LangSmith.

## Before production

- Replace `carry_out` with the real action.
- Switch to a `cue_live_` key to reach people outside your organization.
