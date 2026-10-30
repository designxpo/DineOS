"""Talks to Mezvaan with the device token. Standard library only."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections import deque
from typing import Any, Callable


class CloudError(Exception):
    pass


class CloudClient:
    """
    Readings that cannot be sent (internet down) wait in a bounded queue and go out in order
    with the next batch; the cloud ignores any that arrive after a newer reading.
    """

    def __init__(self, api_url: str, token: str, opener: Callable[..., Any] = urllib.request.urlopen, timeout: float = 10.0, max_queue: int = 2000):
        self.api_url = api_url.rstrip("/")
        self.token = token
        self.opener = opener
        self.timeout = timeout
        self.pending: deque[dict] = deque(maxlen=max_queue)

    def _request(self, method: str, path: str, body: Any = None, data: bytes | None = None, content_type: str | None = None) -> Any:
        headers = {"authorization": f"Bearer {self.token}"}
        if body is not None:
            data = json.dumps(body).encode()
            content_type = "application/json"
        if content_type:
            headers["content-type"] = content_type
        req = urllib.request.Request(f"{self.api_url}/v1{path}", data=data, method=method, headers=headers)
        try:
            with self.opener(req, timeout=self.timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            raise CloudError(f"{method} {path}: HTTP {err.code} {err.read()[:200]!r}") from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise CloudError(f"{method} {path}: {err}") from err

    def config(self) -> dict:
        return self._request("GET", "/vision/config")

    def send(self, readings: list[dict]) -> list[dict]:
        """Queues readings and flushes the queue. Returns the cloud's per-reading results."""
        self.pending.extend(readings)
        if not self.pending:
            return []
        batch = list(self.pending)[:200]
        result = self._request("POST", "/vision/table-state", {"readings": batch})
        for _ in batch:
            self.pending.popleft()
        return result.get("results", []) if result else []

    def heartbeat(self, cameras: list[dict]) -> None:
        self._request("POST", "/vision/heartbeat", {"cameras": cameras})

    def upload_snapshot(self, camera_id: str, jpeg: bytes, width: int, height: int) -> None:
        self._request("PUT", f"/vision/cameras/{camera_id}/snapshot?width={width}&height={height}", data=jpeg, content_type="image/jpeg")
