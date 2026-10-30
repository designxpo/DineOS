"""Mezvaan table vision: edge worker that turns camera frames into table states.

Only a state (vacant, occupied, needs_cleaning) and a confidence per table leave the outlet.
Frames are processed in memory and dropped; nothing identifies a person.
"""

__version__ = "0.1.0"


def setting(name: str, default: str | None = None) -> str | None:
    """MEZMITRA_<name>, or DINEOS_<name> (the product's earlier name) on boxes set up before the rename."""
    import os

    return os.environ.get(f"MEZMITRA_{name}") or os.environ.get(f"DINEOS_{name}") or default

