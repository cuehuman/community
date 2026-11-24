"""The CueHuman calls this sample needs: create a request, read it, and check a webhook's signature.

Reads CUEHUMAN_API_KEY, CUEHUMAN_WEBHOOK_NAME and CUEHUMAN_WEBHOOK_SECRET from the environment.
"""

import hashlib
import hmac
import os
import time

import httpx

API_URL = os.environ.get("CUEHUMAN_API_URL", "https://api.cuehuman.ai")


class CueHumanError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.code = code


def _call(method: str, path: str, json: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {os.environ['CUEHUMAN_API_KEY']}"}
    for attempt in range(3):
        try:
            response = httpx.request(method, f"{API_URL}{path}", headers=headers, json=json, timeout=30.0)
            break
        except httpx.TransportError:  # A dropped or timed-out connection. Both calls are safe to repeat.
            if attempt == 2:
                raise
            time.sleep(2**attempt)
    if response.is_success:
        return response.json()
    error = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    raise CueHumanError(response.status_code, error.get("code", "unknown"), error.get("error", response.text))


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


def get_request(request_id: str) -> dict:
    """Reads a request by its request ID or by your external_task_id."""
    return _call("GET", f"/v1/requests/{request_id}")


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


def verify_webhook(raw_body: bytes, signature_header: str, tolerance_seconds: int = 300) -> bool:
    """Checks the X-CueHuman-Signature header, `t=<unix seconds>,v1=<signature>`, against the raw body."""
    parts = dict(part.split("=", 1) for part in signature_header.split(",") if "=" in part)
    timestamp, received = parts.get("t", ""), parts.get("v1", "")
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > tolerance_seconds:
        return False
    secret = os.environ["CUEHUMAN_WEBHOOK_SECRET"].encode()
    expected = hmac.new(secret, f"{timestamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, received)
