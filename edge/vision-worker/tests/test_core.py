import unittest

from dineos_vision.geometry import box_overlap, center_in_zone, iou, point_in_polygon
from dineos_vision.tracking import Detection, Tracker
from dineos_vision.zones import NEEDS_CLEANING, OCCUPIED, VACANT, Debouncer, classify_zone

SQUARE = [(0.2, 0.2), (0.6, 0.2), (0.6, 0.6), (0.2, 0.6)]
# An L shape, to make sure concave zones work (tables pushed together).
ELL = [(0.1, 0.1), (0.5, 0.1), (0.5, 0.3), (0.3, 0.3), (0.3, 0.5), (0.1, 0.5)]
W, H = 1000, 1000


class GeometryTest(unittest.TestCase):
    def test_point_in_polygon(self):
        self.assertTrue(point_in_polygon(0.4, 0.4, SQUARE))
        self.assertFalse(point_in_polygon(0.7, 0.4, SQUARE))
        self.assertTrue(point_in_polygon(0.2, 0.4, ELL))
        self.assertFalse(point_in_polygon(0.4, 0.4, ELL))  # the notch

    def test_seated_person_overlaps_by_lower_body(self):
        # Head above the table zone, hips and legs inside it.
        seated = (300, 50, 450, 450)
        self.assertGreaterEqual(box_overlap(seated, SQUARE, W, H), 0.3)
        passing = (700, 100, 850, 900)
        self.assertEqual(box_overlap(passing, SQUARE, W, H), 0.0)

    def test_center_and_iou(self):
        self.assertTrue(center_in_zone((350, 350, 400, 400), SQUARE, W, H))
        self.assertFalse(center_in_zone((650, 350, 700, 400), SQUARE, W, H))
        self.assertAlmostEqual(iou((0, 0, 10, 10), (5, 0, 15, 10)), 1 / 3)
        self.assertEqual(iou((0, 0, 10, 10), (20, 20, 30, 30)), 0.0)


class TrackerTest(unittest.TestCase):
    def test_needs_a_few_frames_and_survives_a_missed_one(self):
        tracker = Tracker(min_hits=3, max_misses=2)
        guest = Detection("person", 0.9, (300, 100, 450, 450))
        self.assertEqual(tracker.update([guest]), [])
        self.assertEqual(tracker.update([guest]), [])
        self.assertEqual(len(tracker.update([guest])), 1)
        self.assertEqual(len(tracker.update([])), 1)  # one missed frame
        self.assertEqual(len(tracker.update([])), 1)
        self.assertEqual(tracker.update([]), [])  # gone after max_misses

    def test_single_false_box_never_counts(self):
        tracker = Tracker(min_hits=3)
        tracker.update([Detection("person", 0.5, (0, 0, 50, 50))])
        self.assertEqual(tracker.update([]), [])

    def test_labels_do_not_mix(self):
        tracker = Tracker(min_hits=1)
        tracks = tracker.update([Detection("person", 0.9, (0, 0, 100, 100)), Detection("cup", 0.8, (0, 0, 100, 100))])
        self.assertEqual(sorted(t.label for t in tracks), ["cup", "person"])


class ZoneTest(unittest.TestCase):
    def tracks(self, *dets):
        t = Tracker(min_hits=1)
        return t.update(list(dets))

    def test_classify(self):
        person = Detection("person", 0.9, (300, 50, 450, 450))
        cup = Detection("cup", 0.7, (350, 350, 380, 380))
        stranger = Detection("person", 0.9, (700, 100, 850, 900))
        self.assertEqual(classify_zone(self.tracks(person, cup), SQUARE, W, H), OCCUPIED)
        self.assertEqual(classify_zone(self.tracks(cup), SQUARE, W, H), NEEDS_CLEANING)
        self.assertEqual(classify_zone(self.tracks(stranger), SQUARE, W, H), VACANT)
        self.assertEqual(classify_zone([], SQUARE, W, H), VACANT)


class DebouncerTest(unittest.TestCase):
    def test_holds_before_reporting(self):
        d = Debouncer(hold_seconds=25)
        out = [d.observe(OCCUPIED, t / 2) for t in range(0, 48)]  # 0..23.5 s
        self.assertTrue(all(x is None for x in out))
        changes = [x for x in (d.observe(OCCUPIED, t / 2) for t in range(48, 60)) if x]
        self.assertEqual(changes, [(OCCUPIED, 1.0)])

    def test_a_waiter_walking_past_is_ignored(self):
        d = Debouncer(hold_seconds=25)
        for t in range(0, 120):
            d.observe(VACANT, t / 2)
        self.assertEqual(d.stable, VACANT)
        # Three seconds of someone standing in the zone, then gone.
        changes = [d.observe(OCCUPIED if 60 <= t / 2 < 63 else VACANT, t / 2) for t in range(120, 240)]
        self.assertTrue(all(c is None for c in changes))

    def test_confidence_is_the_agreeing_share(self):
        d = Debouncer(hold_seconds=10, min_share=0.8)
        for t in range(0, 40):
            d.observe(VACANT, t / 2)
        change = None
        for t in range(40, 80):
            s = NEEDS_CLEANING if t % 10 else VACANT  # 90% agree
            change = d.observe(s, t / 2) or change
        self.assertIsNotNone(change)
        self.assertEqual(change[0], NEEDS_CLEANING)
        self.assertGreaterEqual(change[1], 0.8)
        self.assertLess(change[1], 1.0)

    def test_keepalive(self):
        d = Debouncer(hold_seconds=2)
        for t in range(0, 10):
            d.observe(OCCUPIED, t / 2)
        self.assertIsNone(d.keepalive(5, every=300))
        self.assertEqual(d.keepalive(400, every=300)[0], OCCUPIED)
        self.assertIsNone(d.keepalive(410, every=300))


if __name__ == "__main__":
    unittest.main()
