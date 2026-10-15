"""
python -m dineos_vision            run the worker
python -m dineos_vision check      test the cloud connection and each camera stream
python -m dineos_vision collect    save frames locally for labelling (opt-in, see README)

Environment:
  DINEOS_API_URL         e.g. https://api.dineos.in
  DINEOS_DEVICE_TOKEN    dv_... token of the camera box from Settings > Cameras
  DINEOS_MODEL           path to yolox_s.onnx (default: models/yolox_s.onnx)
  DINEOS_RTSP_<REF>      stream address per camera, or DINEOS_CAMERAS_FILE=cameras.json
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

from .camera import FrameSource, private_still, stream_url
from .cloud import CloudClient, CloudError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dineos_vision")
    parser.add_argument("command", nargs="?", default="run", choices=["run", "check", "collect"])
    parser.add_argument("--camera", help="camera ref for collect")
    parser.add_argument("--every", type=float, default=30, help="seconds between saved frames (collect)")
    parser.add_argument("--out", default="frames", help="folder for collected frames")
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.environ.get("DINEOS_LOG", "INFO"), format="%(asctime)s %(levelname)s %(message)s")

    token = os.environ.get("DINEOS_DEVICE_TOKEN", "")
    if not token.startswith("dv_"):
        print("Set DINEOS_DEVICE_TOKEN to the camera box token from Settings > Cameras.", file=sys.stderr)
        return 1
    cloud = CloudClient(os.environ.get("DINEOS_API_URL", "http://localhost:4000"), token)

    if args.command == "check":
        try:
            config = cloud.config()
        except CloudError as err:
            print(f"Cloud: FAILED ({err})")
            return 1
        print(f"Cloud: ok, {len(config['cameras'])} camera(s)")
        for cam in config["cameras"]:
            url = stream_url(cam["rtsp_secret_ref"])
            if not url:
                print(f"  {cam['name']}: no stream address (set DINEOS_RTSP_{cam['rtsp_secret_ref'].upper()})")
                continue
            source = FrameSource(url, fps=2)
            frame = None
            for _ in range(20):
                frame = source.read()
                if frame is not None:
                    break
                time.sleep(0.5)
            print(f"  {cam['name']}: {'ok ' + str(frame.shape[1]) + 'x' + str(frame.shape[0]) if frame is not None else 'FAILED ' + str(source.error)}, {len(cam['zones'])} table zone(s)")
        return 0

    if args.command == "collect":
        # Raw frames for fine-tuning the detector. They stay on this box; follow the privacy
        # notes in README.md (signage, no washrooms or staff rooms, delete after labelling).
        if not args.camera:
            print("Give --camera <ref>", file=sys.stderr)
            return 1
        import cv2

        url = stream_url(args.camera)
        if not url:
            print(f"No stream address for {args.camera}", file=sys.stderr)
            return 1
        out = Path(args.out) / args.camera
        out.mkdir(parents=True, exist_ok=True)
        source = FrameSource(url, fps=1 / args.every)
        print(f"Saving a frame every {args.every:.0f}s to {out}. Ctrl+C to stop.")
        while True:
            frame = source.read()
            if frame is not None:
                cv2.imwrite(str(out / f"{int(time.time())}.jpg"), frame)
            time.sleep(0.5)

    from .detector import YoloxDetector
    from .worker import Worker

    model = os.environ.get("DINEOS_MODEL", "models/yolox_s.onnx")
    if not Path(model).exists():
        print(f"Model not found at {model}. See README.md to export yolox_s.onnx.", file=sys.stderr)
        return 1
    worker = Worker(cloud, YoloxDetector(model), open_source=FrameSource, still=private_still)
    worker.run(stream_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
