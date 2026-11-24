# Pause until a person uploads the documents you need

A workflow that collects files. The graph needs a receipt and a photo before it can finish a claim, so it asks the customer to upload them, pauses, and saves the files when they arrive.

It builds on [pause and resume](../pause-and-resume/), and uses the same webhook endpoint. This page first shows the code you add to your own graph, then how to run the complete example in this folder.

## How it works

1. The graph creates a file request and pauses. The request says which file types are accepted, how many files, and the labels the person picks from.
2. CueHuman emails the person a link. They upload their files on the request form and label each one.
3. CueHuman calls your webhook with `request.human_submitted`.
4. The endpoint resumes the run with the list of files: each one's ID, name, label and size.
5. The next node reads the request, downloads each file and saves it.

## Add it to your graph

### 1. Create the file request in its own node

From `graph.py`:

```python
def ask_for_documents(state: State, config: RunnableConfig) -> State:
    """Creates the file request. Its own node, so it is not repeated when the run resumes."""
    request = cuehuman.create_file_request(
        external_task_id=config["configurable"]["thread_id"],  # How the webhook finds this run.
        email=state["customer_email"],
        prompt=f"To finish {state['claim']}, please upload your receipt and a photo of the damage.",
        categories=CATEGORIES,
    )
    return {"request_id": request["request_id"]}
```

It is the same call as an approval, with `type` set to `file`. From `cuehuman.py`:

```python
def create_file_request(*, external_task_id: str, email: str, prompt: str, categories: list[str]) -> dict:
    """Asks one human to upload files. Safe to call again with the same external_task_id."""
    body = {
        "external_task_id": external_task_id,
        "human": {"email": email},
        "type": "file",
        "prompt": prompt,
        "schema": {
            "content_types": ["application/pdf", "image/jpeg", "image/png"],
            "categories": categories,  # The human labels each file with one of these.
            "max_files": 3,
        },
        "webhook_name": os.environ["CUEHUMAN_WEBHOOK_NAME"],  # The profile that points at your endpoint.
    }
    if os.environ.get("CUEHUMAN_EXPIRES_IN_SECONDS"):  # When not set, the human has 10 days to answer.
        body["expires_in_seconds"] = int(os.environ["CUEHUMAN_EXPIRES_IN_SECONDS"])
    try:
        return _call("POST", "/v1/requests", json=body)
    except CueHumanError as err:
        # The request for this task has already ended: read it instead of creating another.
        if err.code != "external_task_id_conflict":
            raise
        return get_request(external_task_id)
```

CueHuman refuses a file of any other type.

### 2. Download the files when the run resumes

From `graph.py`:

```python
def save_documents(state: State, config: RunnableConfig) -> State:
    """Downloads the files into a folder for this run. Replace this with your own storage."""
    folder = f"received/{config['configurable']['thread_id']}"
    saved = cuehuman.download_files(state["request_id"], folder)
    labels = ", ".join(f"{file['name']} ({file['category']})" for file in state["answer"]["files"])
    return {"outcome": f"Saved {len(saved)} files to {folder}: {labels}"}
```

From `cuehuman.py`:

```python
def download_files(request_id: str, folder: str) -> list[str]:
    """Saves the files the human uploaded, and returns where each one was saved.

    A download link works for 15 minutes from the read that returned it, so the request is
    read here, just before the downloads, and the links are never stored.
    """
    request = get_request(request_id)
    os.makedirs(folder, exist_ok=True)
    saved = []
    for file in request["result"]["files"]:
        # The file ID keeps names apart, and basename keeps the human's file name inside the folder.
        path = os.path.join(folder, f"{file['id']}-{os.path.basename(file['name'])}")
        response = httpx.get(file["download_url"], timeout=120.0)
        response.raise_for_status()
        with open(path, "wb") as out:
            out.write(response.content)
        saved.append(path)
    return saved
```

- **Read the request just before you download.** A download link works for 15 minutes from the read that returned it. The endpoint passes the run the files' IDs and names, not their links, so a link is never saved with the run.
- **Do not trust the file name.** It is what the person's device sent. The sample keeps only its last part and puts the file ID in front.

The webhook endpoint itself is the one from [pause and resume](../pause-and-resume/): it checks the `X-CueHuman-Signature` header, then resumes the run. It is part of your own app. The one change is what it passes to the run: the list of files, where the approval samples pass the choice.

## Run the complete example

| File | What it does |
|---|---|
| `graph.py` | The graph: ask for documents, wait, then save them |
| `webhook_server.py` | The webhook endpoint that resumes the waiting run |
| `cuehuman.py` | The CueHuman calls: create a file request, read it, download its files, check a webhook's signature |
| `start_run.py` | Starts a run and exits while it waits |
| `show_run.py` | Shows where a run is |

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

In a second terminal, start a run. With a test key, the address must belong to a member of your organization.

```bash
python start_run.py "your damage claim for order 1042" customer@example.com
```

Open the email and upload a PDF or an image. The endpoint logs the resume, and the files are in the `received` folder:

```
Resumed claim-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed after request.human_submitted -> Saved 2 files to received/claim-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed: receipt.pdf (Receipt), damage.png (Photo of the damage)
```

Check a run at any time:

```bash
python show_run.py claim-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed
```

## Before production

- Use a Postgres checkpointer in place of SQLite.
- Save the files to your own storage in place of a local folder.
- Switch to a `cue_live_` key to reach people outside your organization.

## Tracing with LangSmith

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `.env`. Each run then appears in LangSmith as one trace that ends at the pause, and one more for each resume.
