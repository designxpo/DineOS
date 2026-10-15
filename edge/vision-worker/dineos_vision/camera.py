"""RTSP frames via OpenCV, plus the private still used to draw zones."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .tracking import PERSON, Detection


def stream_url(ref: str, config_file: str | None = None) -> str | None:
    """
    The RTSP address (with its password) lives only on this box: an environment variable
    DINEOS_RTSP_<REF>, or a JSON file {"<ref>": "rtsp://..."}. The cloud only knows the ref.
    """
    env = os.environ.get(f"DINEOS_RTSP_{ref.upper()}")
    if env:
        return env
    path = Path(config_file or os.environ.get("DINEOS_CAMERAS_FILE", "cameras.json"))
    if path.exists():
        return json.loads(path.read_text()).get(ref)
    return None


class FrameSource:
    """Keeps an RTSP stream open, reconnecting with backoff, and yields at most `fps` frames."""

    def __init__(self, url: str, fps: float):
        self.url = url
        self.interval = 1.0 / fps
        self.capture: Any = None
        self.next_at = 0.0
        self.retry_at = 0.0
        self.error: str | None = None

    def read(self) -> Any | None:
        import cv2

        now = time.monotonic()
        if now < self.next_at or now < self.retry_at:
            return None
        if self.capture is None:
            self.capture = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            if not self.capture.isOpened():
                self.capture = None
                self.error = "cannot open stream"
                self.retry_at = now + 10
                return None
        # Drop buffered frames so decisions use the newest picture.
        self.capture.grab()
        ok, frame = self.capture.read()
        if not ok:
            self.capture.release()
            self.capture = None
            self.error = "stream stopped"
            self.retry_at = now + 5
            return None
        self.error = None
        self.next_at = now + self.interval
        return frame


def private_still(frame: Any, detections: list[Detection], max_width: int = 1280) -> tuple[bytes, int, int]:
    """A JPEG for drawing zones with every person blurred out (spec §11: no identification)."""
    import cv2

    image = frame.copy()
    h, w = image.shape[:2]
    for d in detections:
        if d.label != PERSON:
            continue
        x1, y1, x2, y2 = (max(0, int(v)) for v in d.box)
        x2, y2 = min(w, x2), min(h, y2)
        if x2 - x1 > 2 and y2 - y1 > 2:
            image[y1:y2, x1:x2] = cv2.GaussianBlur(image[y1:y2, x1:x2], (0, 0), sigmaX=max(8, (x2 - x1) / 6))
    if w > max_width:
        scale = max_width / w
        image = cv2.resize(image, (max_width, int(h * scale)))
    ok, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        raise RuntimeError("could not encode still")
    oh, ow = image.shape[:2]
    return jpeg.tobytes(), ow, oh
