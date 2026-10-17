"""Detections and a small IoU tracker that smooths flicker between frames (spec §11 step 3)."""

from __future__ import annotations

from dataclasses import dataclass, field

from .geometry import Box, iou

# COCO classes the detector reports that matter at a table.
PERSON = "person"
TABLE_ITEMS = frozenset({"cup", "bowl", "bottle", "wine glass", "fork", "knife", "spoon"})
WANTED = frozenset({PERSON, "chair", *TABLE_ITEMS})


@dataclass(frozen=True)
class Detection:
    label: str
    score: float
    box: Box


@dataclass
class Track:
    id: int
    label: str
    box: Box
    score: float
    hits: int = 1
    misses: int = 0


@dataclass
class Tracker:
    """
    Matches detections to existing tracks by IoU (same label). A track counts once it has been
    seen in `min_hits` frames and is kept through `max_misses` frames without a match, so one
    missed frame does not make a guest vanish and one false box does not make one appear.
    """

    min_hits: int = 3
    max_misses: int = 4
    match_iou: float = 0.3
    tracks: list[Track] = field(default_factory=list)
    _next: int = 1

    def update(self, detections: list[Detection]) -> list[Track]:
        unmatched = list(range(len(detections)))
        for track in self.tracks:
            best, best_iou = -1, self.match_iou
            for idx in unmatched:
                d = detections[idx]
                if d.label != track.label:
                    continue
                overlap = iou(track.box, d.box)
                if overlap >= best_iou:
                    best, best_iou = idx, overlap
            if best >= 0:
                d = detections[best]
                track.box, track.score = d.box, d.score
                track.hits += 1
                track.misses = 0
                unmatched.remove(best)
            else:
                track.misses += 1
        self.tracks = [t for t in self.tracks if t.misses <= self.max_misses]
        for idx in unmatched:
            d = detections[idx]
            self.tracks.append(Track(id=self._next, label=d.label, box=d.box, score=d.score))
            self._next += 1
        return [t for t in self.tracks if t.hits >= self.min_hits]
