# Send a file and a link for the person to review

An approval where the approver has something to look at. The agent prepared a quote as a PDF, so the graph uploads the file, attaches it to the request with a link to the order, and pauses until the approver has reviewed them.

It builds on [pause and resume](../pause-and-resume/), and uses the same webhook endpoint. This page first shows the code you add to your own graph, then how to run the complete example in this folder.

## How it works

1. The graph uploads the file to CueHuman and gets an attachment ID back.
2. It creates the request with two attachments, the uploaded file and a link, and pauses.
3. CueHuman emails the approver a link to the request form. The form shows the question, a download control for the file, and the link.
4. The approver reviews them and answers, and CueHuman calls your webhook with `request.human_submitted`.
5. The endpoint resumes the run, as in pause and resume.

## Add it to your graph

### 1. Upload the file

From `cuehuman.py`:

```python
def upload_attachment(path: str, content_type: str) -> str:
    """Uploads a file for one request, and returns the attachment ID to name when you create it."""
    with open(path, "rb") as file:
        data = file.read()
    described = {"name": os.path.basename(path), "content_type": content_type, "size_bytes": len(data)}
    presigned = _call("POST", "/v1/assets/presign-upload", json={"purpose": "request_attachment", "files": [described]})
    upload = presigned["uploads"][0]
    # The file goes straight to storage: the same Content-Type, and no Authorization header.
    response = httpx.put(upload["upload_url"], content=data, headers={"Content-Type": content_type}, timeout=120.0)
    response.raise_for_status()
    return upload["id"]
```

The upload has two calls. `POST /v1/assets/presign-upload` returns an upload address and an attachment ID, and the file's bytes then go to that address with a `PUT`.

- **Say the exact size and type.** The upload address accepts a body of that length and that `Content-Type` only.
- **The upload address works for 5 minutes,** and a file that is never attached is deleted after about a day.

### 2. Attach the file and the link when you create the request

From `graph.py`:

```python
def ask_human(state: State, config: RunnableConfig) -> State:
    """Uploads the document, then creates the request with it attached. Its own node, so it is not repeated."""
    attachment_id = cuehuman.upload_attachment(state["document_path"], "application/pdf")
    request = cuehuman.create_request(
        external_task_id=config["configurable"]["thread_id"],  # How the webhook finds this run.
        email=state["approver_email"],
        prompt="An AI agent prepared the attached quote. Please review it before it goes to the customer. Do you approve?",
        options=[APPROVE, REJECT],
        attachments=[
            # A file: the approver gets a download control. `name` is the title they see.
            {"id": attachment_id, "name": "Quote for order 1042", "description": "The PDF the customer will receive."},
            # A link: CueHuman shows it and never fetches it.
            {"url": state["link"], "name": "Order 1042", "description": "The order in your own system."},
        ],
    )
    return {"request_id": request["request_id"]}
```

- **A file is attached by its `id`, a link by its `url`.** Each attachment has one or the other.
- **`name` is the title the approver sees,** and `description` is a note beside it.
- **A link must be a public `https` address.** CueHuman shows it to the approver and never fetches it.
- **An uploaded file can be attached to one request.** A request can carry up to 10 attachments.
- **The upload and the create are in the same node,** which runs once. If that node is ever run again, the create returns the first request, and the second upload is never attached and is deleted.

The webhook endpoint itself is the one from [pause and resume](../pause-and-resume/): it checks the `X-CueHuman-Signature` header, then resumes the run. It is part of your own app.

## Run the complete example

| File | What it does |
|---|---|
| `graph.py` | The graph: upload and ask, wait, then carry out or stop |
| `webhook_server.py` | The webhook endpoint that resumes the waiting run |
| `cuehuman.py` | The CueHuman calls: upload a file, create a request with attachments, read it, check a webhook's signature |
| `start_run.py` | Starts a run and exits while it waits |
| `show_run.py` | Shows where a run is |
| `quote.pdf` | A sample document to send |

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

In a second terminal, start a run with the file, a link and the approver's address. With a test key, the address must belong to a member of your organization.

```bash
python start_run.py quote.pdf https://example.com/orders/1042 approver@example.com
```

Open the email. The request form shows the quote to download and the link to the order. Answer, and the endpoint logs the resume:

```
Resumed approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Approved. Sent quote.pdf to the customer.
```

Check a run at any time:

```bash
python show_run.py approval-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

## Before production

- Use a Postgres checkpointer in place of SQLite.
- Replace `carry_out` with the real action.
- Switch to a `cue_live_` key to reach people outside your organization.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. Each run then appears in LangSmith as one trace that ends at the pause, and one more for each resume.
