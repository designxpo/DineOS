"""DineOS table vision: edge worker that turns camera frames into table states.

Only a state (vacant, occupied, needs_cleaning) and a confidence per table leave the outlet.
Frames are processed in memory and dropped; nothing identifies a person.
"""

__version__ = "0.1.0"
