import unittest

try:
    import numpy as np
except ImportError:  # the worker core runs without numpy; only the detector needs it
    np = None


@unittest.skipUnless(np is not None, "numpy not installed")
class PostprocessTest(unittest.TestCase):
    def test_decodes_yolox_grid_output(self):
        from dineos_vision.detector import LABELS, postprocess

        size = 640
        cells = sum((size // s) ** 2 for s in (8, 16, 32))
        raw = np.zeros((1, cells, 85), dtype=np.float32)
        # One confident person on the stride-32 grid, cell (x=5, y=3): centre (5.5*32, 3.5*32).
        offset = (size // 8) ** 2 + (size // 16) ** 2
        cell = offset + 3 * (size // 32) + 5
        raw[0, cell, :4] = [0.5, 0.5, np.log(4), np.log(6)]  # 128 x 192 px box
        raw[0, cell, 4] = 0.95
        raw[0, cell, 5 + LABELS.index("person")] = 0.9
        # A duplicate, slightly weaker box that NMS must drop.
        raw[0, cell + 1, :4] = [-0.45, 0.5, np.log(4), np.log(6)]
        raw[0, cell + 1, 4] = 0.9
        raw[0, cell + 1, 5 + LABELS.index("person")] = 0.85
        # A confident car: not something a table cares about.
        raw[0, cell + 3, :4] = [0.5, 0.5, 1, 1]
        raw[0, cell + 3, 4] = 0.99
        raw[0, cell + 3, 5 + LABELS.index("car")] = 0.99

        found = postprocess(raw, ratio=0.5, size=size, score_threshold=0.35)
        self.assertEqual([d.label for d in found], ["person"])
        x1, y1, x2, y2 = found[0].box
        # Centre (176, 112) in model pixels, back to the frame at ratio 0.5.
        self.assertAlmostEqual((x1 + x2) / 2, 352, delta=1)
        self.assertAlmostEqual((y1 + y2) / 2, 224, delta=1)
        self.assertAlmostEqual(x2 - x1, 256, delta=1)
        self.assertAlmostEqual(y2 - y1, 384, delta=1)
        self.assertAlmostEqual(found[0].score, 0.95 * 0.9, places=3)


if __name__ == "__main__":
    unittest.main()
