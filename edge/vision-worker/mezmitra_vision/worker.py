"""The edge worker loop: frames in, table states out (spec §11)."""

from __future__ import annotations

import datetime as dt
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from .cloud import CloudClient, CloudError
from .tracking import Detection, Tracker
from .zones import Debouncer, classify_zone

log = logging.getLogger("mezmitra.vision")

Detector = Callable[[Any], list[Detection]]


def iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat()


@dataclass
class CameraState:
    id: str
    name: str
    ref: str
    zones: list[dict]
    tracker: Tracker = field(default_factory=Tracker)
    debouncers: dict[str, Debouncer] = field(default_factory=dict)
    fps: float = 0.0
    frames: int = 0
    error: str | None = None


class Worker:
    def __init__(
        self,
        cloud: CloudClient,
        detector: Detector,
        open_source: Callable[[str, float], Any] | None = None,
        still: Callable[[Any, list[Detection]], tuple[bytes, int, int]] | None = None,
        clock: Callable[[], float] = time.time,
    ):
        self.cloud = cloud
        self.detector = detector
        self.open_source = open_source
        self.still = still
        self.clock = clock
        self.settings = {"fps": 2, "hold_seconds": 25, "resend_seconds": 300, "min_confidence": 0.6}
        self.cameras: dict[str, CameraState] = {}
        self.sources: dict[str, Any] = {}
        self.snapshot_wanted: set[str] = set()

    # -------------------------------------------------------------- configuration

    def apply_config(self, config: dict) -> None:
        self.settings.update(config.get("settings", {}))
        seen = set()
        for cam in config.get("cameras", []):
            seen.add(cam["id"])
            state = self.cameras.get(cam["id"])
            if state is None:
                state = self.cameras[cam["id"]] = CameraState(cam["id"], cam["name"], cam["rtsp_secret_ref"], cam["zones"])
            else:
                state.zones = cam["zones"]
            # Zones that moved start over; their old readings no longer mean anything.
            wanted = {z["table_id"] for z in state.zones}
            state.debouncers = {k: v for k, v in state.debouncers.items() if k in wanted}
            if cam.get("snapshot_requested"):
                self.snapshot_wanted.add(cam["id"])
        for gone in set(self.cameras) - seen:
            self.cameras.pop(gone)
            self.sources.pop(gone, None)

    # -------------------------------------------------------------- one frame

    def step(self, camera_id: str, frame: Any, width: int, height: int, t: float | None = None) -> list[dict]:
        """Runs one frame through detection, tracking and every zone. Returns readings to send."""
        cam = self.cameras[camera_id]
        now = self.clock() if t is None else t
        detections = self.detector(frame)
        tracks = cam.tracker.update(detections)
        cam.frames += 1
        readings = []
        for zone in cam.zones:
            observed = classify_zone(tracks, zone["polygon"], width, height)
            deb = cam.debouncers.setdefault(zone["table_id"], Debouncer(hold_seconds=float(self.settings["hold_seconds"])))
            change = deb.observe(observed, now) or deb.keepalive(now, float(self.settings["resend_seconds"]))
            if change and change[1] >= float(self.settings["min_confidence"]):
                readings.append({"table_id": zone["table_id"], "state": change[0], "confidence": change[1], "observed_at": iso(now)})
        if camera_id in self.snapshot_wanted and self.still:
            try:
                jpeg, w, h = self.still(frame, detections)
                self.cloud.upload_snapshot(camera_id, jpeg, w, h)
                self.snapshot_wanted.discard(camera_id)
            except (CloudError, RuntimeError) as err:
                log.warning("still for %s not sent: %s", cam.name, err)
        return readings

    def flush(self, readings: list[dict]) -> None:
        try:
            self.cloud.send(readings)
        except CloudError as err:
            log.warning("readings kept for later (%d waiting): %s", len(self.cloud.pending), err)

    def heartbeat(self) -> None:
        payload = [{"camera_id": c.id, "ok": c.error is None, "fps": round(c.fps, 2), "error": c.error} for c in self.cameras.values()]
        try:
            self.cloud.heartbeat(payload)
        except CloudError as err:
            log.warning("heartbeat failed: %s", err)

    # -------------------------------------------------------------- forever

    def run(self, stream_url: Callable[[str], str | None], config_every: float = 300, heartbeat_every: float = 60) -> None:  # pragma: no cover - needs cameras
        next_config = next_beat = 0.0
        fps_window: dict[str, list[float]] = {}
        while True:
            now = time.monotonic()
            if now >= next_config:
                try:
                    self.apply_config(self.cloud.config())
                    next_config = now + config_every
                except CloudError as err:
                    log.warning("config not refreshed: %s", err)
                    next_config = now + 30
            for cam in list(self.cameras.values()):
                source = self.sources.get(cam.id)
                if source is None:
                    url = stream_url(cam.ref)
                    if not url:
                        cam.error = f"no stream address for '{cam.ref}' on this box"
                        continue
                    source = self.sources[cam.id] = self.open_source(url, float(self.settings["fps"]))  # type: ignore[misc]
                frame = source.read()
                cam.error = source.error
                if frame is None:
                    continue
                stamps = fps_window.setdefault(cam.id, [])
                stamps.append(now)
                del stamps[:-20]
                if len(stamps) > 1:
                    cam.fps = (len(stamps) - 1) / max(stamps[-1] - stamps[0], 1e-6)
                height, width = frame.shape[:2]
                readings = self.step(cam.id, frame, width, height)
                if readings or self.cloud.pending:
                    self.flush(readings)
            if now >= next_beat:
                self.heartbeat()
                next_beat = now + heartbeat_every
            time.sleep(0.05)
