"""
YOLOX object detector on ONNX Runtime (CPU is enough at 2 fps for a few cameras).

numpy, onnxruntime and OpenCV are imported only when a detector is created, so the rest of
the worker (zones, tracking, debouncing, cloud) runs and is tested with the standard library.
See README.md for exporting yolox_s.onnx.
"""

from __future__ import annotations

from typing import Any

from .tracking import WANTED, Detection

# The 80 COCO classes in YOLOX output order.
COCO = (
    "person bicycle car motorcycle airplane bus train truck boat traffic_light fire_hydrant stop_sign parking_meter bench bird cat dog horse "
    "sheep cow elephant bear zebra giraffe backpack umbrella handbag tie suitcase frisbee skis snowboard sports_ball kite baseball_bat "
    "baseball_glove skateboard surfboard tennis_racket bottle wine_glass cup fork knife spoon bowl banana apple sandwich orange broccoli "
    "carrot hot_dog pizza donut cake chair couch potted_plant bed dining_table toilet tv laptop mouse remote keyboard cell_phone microwave "
    "oven toaster sink refrigerator book clock vase scissors teddy_bear hair_drier toothbrush"
).split()
LABELS = [c.replace("_", " ") for c in COCO]


def letterbox(image: Any, size: int) -> tuple[Any, float]:
    """Resizes keeping aspect ratio and pads with grey, as YOLOX was trained."""
    import cv2
    import numpy as np

    h, w = image.shape[:2]
    ratio = min(size / h, size / w)
    resized = cv2.resize(image, (int(w * ratio), int(h * ratio)), interpolation=cv2.INTER_LINEAR)
    padded = np.full((size, size, 3), 114, dtype=np.uint8)
    padded[: resized.shape[0], : resized.shape[1]] = resized
    return padded, ratio


def decode(outputs: Any, size: int, strides: tuple[int, ...] = (8, 16, 32)) -> Any:
    """Turns raw YOLOX grid outputs (cx, cy, w, h offsets per cell) into image coordinates."""
    import numpy as np

    grids, expanded = [], []
    for stride in strides:
        n = size // stride
        xv, yv = np.meshgrid(np.arange(n), np.arange(n))
        grids.append(np.stack((xv, yv), 2).reshape(1, -1, 2))
        expanded.append(np.full((1, n * n, 1), stride))
    grid = np.concatenate(grids, 1)
    stride_map = np.concatenate(expanded, 1)
    out = outputs.copy()
    out[..., :2] = (out[..., :2] + grid) * stride_map
    out[..., 2:4] = np.exp(out[..., 2:4]) * stride_map
    return out


def nms(boxes: Any, scores: Any, threshold: float) -> list[int]:
    import numpy as np

    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        area_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        area_o = (boxes[order[1:], 2] - boxes[order[1:], 0]) * (boxes[order[1:], 3] - boxes[order[1:], 1])
        overlap = inter / (area_i + area_o - inter + 1e-9)
        order = order[1:][overlap <= threshold]
    return keep


def postprocess(raw: Any, ratio: float, size: int, score_threshold: float, nms_threshold: float = 0.45) -> list[Detection]:
    """raw: (1, N, 85) YOLOX output. Returns detections of the classes a table cares about."""
    import numpy as np

    pred = decode(raw, size)[0]
    boxes = np.empty((pred.shape[0], 4), dtype=np.float32)
    boxes[:, 0] = pred[:, 0] - pred[:, 2] / 2
    boxes[:, 1] = pred[:, 1] - pred[:, 3] / 2
    boxes[:, 2] = pred[:, 0] + pred[:, 2] / 2
    boxes[:, 3] = pred[:, 1] + pred[:, 3] / 2
    boxes /= ratio
    scores = pred[:, 4:5] * pred[:, 5:]
    classes = scores.argmax(1)
    best = scores[np.arange(len(classes)), classes]
    found: list[Detection] = []
    for cls in np.unique(classes[best >= score_threshold]):
        label = LABELS[int(cls)]
        if label not in WANTED:
            continue
        idx = np.where((classes == cls) & (best >= score_threshold))[0]
        for k in nms(boxes[idx], best[idx], nms_threshold):
            b = boxes[idx[k]]
            found.append(Detection(label, float(best[idx[k]]), (float(b[0]), float(b[1]), float(b[2]), float(b[3]))))
    return found


class YoloxDetector:
    def __init__(self, model_path: str, size: int = 640, score_threshold: float = 0.35, threads: int = 2):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        self.session = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name
        self.size = size
        self.score_threshold = score_threshold

    def __call__(self, frame: Any) -> list[Detection]:
        import numpy as np

        image, ratio = letterbox(frame, self.size)
        blob = np.ascontiguousarray(image.transpose(2, 0, 1)[None], dtype=np.float32)
        raw = self.session.run(None, {self.input: blob})[0]
        return postprocess(raw, ratio, self.size, self.score_threshold)
