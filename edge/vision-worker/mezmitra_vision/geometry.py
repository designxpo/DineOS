"""Zones are polygons drawn in the portal on a camera still, in 0..1 coordinates."""

from __future__ import annotations

from typing import Sequence

Point = tuple[float, float]
Box = tuple[float, float, float, float]  # x1, y1, x2, y2 in pixels


def point_in_polygon(x: float, y: float, polygon: Sequence[Point]) -> bool:
    """Ray casting; points on an edge may fall either way, which is fine for zones."""
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y):
            cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < cross:
                inside = not inside
        j = i
    return inside


def box_overlap(box: Box, polygon: Sequence[Point], width: int, height: int, lower: float = 0.6, grid: int = 5) -> float:
    """
    Share of the box's lower part that lies in the zone. People sitting at a table are mostly
    hidden below the table top, so the lower part of their box is what overlaps the table zone.
    """
    x1, y1, x2, y2 = box
    top = y2 - (y2 - y1) * lower
    hits = 0
    for i in range(grid):
        for j in range(grid):
            px = x1 + (x2 - x1) * (i + 0.5) / grid
            py = top + (y2 - top) * (j + 0.5) / grid
            if point_in_polygon(px / width, py / height, polygon):
                hits += 1
    return hits / (grid * grid)


def center_in_zone(box: Box, polygon: Sequence[Point], width: int, height: int) -> bool:
    x1, y1, x2, y2 = box
    return point_in_polygon((x1 + x2) / 2 / width, (y1 + y2) / 2 / height, polygon)


def iou(a: Box, b: Box) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter == 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)
