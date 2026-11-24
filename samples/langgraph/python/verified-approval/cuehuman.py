"""The CueHuman calls this sample needs: create a verified request, read it, check its signed
receipt, and check a webhook's signature.

Reads CUEHUMAN_API_KEY, CUEHUMAN_WEBHOOK_NAME and CUEHUMAN_WEBHOOK_SECRET from the environment.
"""

import base64
import hashlib
import hmac
import json
import os
import time

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

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


def create_request(*, external_task_id: str, email: str, prompt: str, options: list[str]) -> dict:
    """Asks one human to pick one of the options. Safe to call again with the same external_task_id."""
    body = {
        "external_task_id": external_task_id,
        "human": {"email": email},
        "type": "decision",
        "prompt": prompt,
        "schema": {"options": options},
        "allow_comment": True,
        "verify_human": True,  # The human must enter a code sent to their address before they can answer.
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


def verify_receipt(request: dict) -> bool:
    """Checks CueHuman's signed receipt: that the answer you hold is the answer CueHuman recorded."""
    receipt, verification = request.get("receipt"), request.get("verification") or {}
    if not receipt:
        return False  # Not answered yet, or its content was deleted.

    # The receipt covers these 15 values, exactly as the request returns them.
    signed = {key: request[key] for key in RECEIPT_KEYS}
    signed["verification_method"] = verification.get("method")
    signed["verified_contact"] = verification.get("verified_contact")
    signed["verified_at"] = verification.get("verified_at")
    signed["verification_facts"] = verification.get("facts")
    # Canonical JSON (RFC 8785): sorted keys and no spaces. This is enough for a decision
    # request, whose values are text. A form's numbers need a full RFC 8785 library.
    canonical = json.dumps(signed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if hashlib.sha256(canonical.encode()).hexdigest() != receipt["hash"]:
        return False

    # The signature is Ed25519 over the hash, made with the key the receipt names.
    keys = httpx.get(f"{API_URL}/.well-known/jwks.json", timeout=30.0).json()["keys"]
    key = next((key for key in keys if key["kid"] == receipt["key_id"]), None)
    if not key:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(_base64url(key["x"])).verify(_base64url(receipt["signature"]), receipt["hash"].encode())
        return True
    except InvalidSignature:
        return False


RECEIPT_KEYS = [
    "request_id", "organization_id", "agent_id", "external_task_id", "type", "prompt",
    "schema", "result", "comment", "submitted_at", "verify_human",
]  # fmt: skip


def _base64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_webhook(raw_body: bytes, signature_header: str, tolerance_seconds: int = 300) -> bool:
    """Checks the X-CueHuman-Signature header, `t=<unix seconds>,v1=<signature>`, against the raw body."""
    parts = dict(part.split("=", 1) for part in signature_header.split(",") if "=" in part)
    timestamp, received = parts.get("t", ""), parts.get("v1", "")
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > tolerance_seconds:
        return False
    secret = os.environ["CUEHUMAN_WEBHOOK_SECRET"].encode()
    expected = hmac.new(secret, f"{timestamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, received)
