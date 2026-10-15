"""Per-zone state (spec §11 step 4) and the hold-before-send debouncer (step 5)."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from .geometry import Point, box_overlap, center_in_zone
from .tracking import PERSON, TABLE_ITEMS, Track

VACANT = "vacant"
OCCUPIED = "occupied"
NEEDS_CLEANING = "needs_cleaning"


def classify_zone(tracks: Iterable[Track], zone: Sequence[Point], width: int, height: int, person_overlap: float = 0.3) -> str:
    """People at the table: occupied. Nobody but things left on it: needs cleaning. Else vacant."""
    items = False
    for t in tracks:
        if t.label == PERSON and box_overlap(t.box, zone, width, height) >= person_overlap:
            return OCCUPIED
        if t.label in TABLE_ITEMS and center_in_zone(t.box, zone, width, height):
            items = True
    return NEEDS_CLEANING if items else VACANT


@dataclass
class Debouncer:
    """
    Reports a state only after it has held for `hold_seconds`: the share of observations in that
    window that agree must reach `min_share`. The share is sent as the confidence. Brief
    occlusions (a waiter walking past) never reach the cloud.
    """

    hold_seconds: float = 25.0
    min_share: float = 0.8
    stable: str | None = None
    window: deque = field(default_factory=deque)
    last_sent_at: float | None = None

    def observe(self, state: str, t: float) -> tuple[str, float] | None:
        self.window.append((t, state))
        while self.window and self.window[0][0] < t - self.hold_seconds:
            self.window.popleft()
        # Need a full hold window of evidence before deciding anything.
        if t - self.window[0][0] < self.hold_seconds * 0.95:
            return None
        counts: dict[str, int] = {}
        for _, s in self.window:
            counts[s] = counts.get(s, 0) + 1
        leader = max(counts, key=lambda k: counts[k])
        share = counts[leader] / len(self.window)
        if leader != self.stable and share >= self.min_share:
            self.stable = leader
            self.last_sent_at = t
            return leader, round(share, 3)
        return None

    def keepalive(self, t: float, every: float) -> tuple[str, float] | None:
        """Resends the stable state now and then so the cloud knows the reading is still current."""
        if self.stable is None or (self.last_sent_at is not None and t - self.last_sent_at < every):
            return None
        self.last_sent_at = t
        agree = sum(1 for _, s in self.window if s == self.stable)
        return self.stable, round(agree / len(self.window), 3) if self.window else 1.0
