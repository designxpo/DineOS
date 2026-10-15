# DineOS table vision: edge worker

Optional add-on (Phase 3). A small computer at the outlet reads the existing IP cameras, decides for every table zone whether it is **vacant**, **occupied** or **needs cleaning**, and sends only that state and a confidence to DineOS. Orders and bills always win: the cloud uses a camera reading only when a table has no open visit (spec §5).

```
IP cameras (RTSP) ──> this worker ──HTTPS──> DineOS: POST /v1/vision/table-state
                        detect → track → zone → hold 25 s → send
```

## What leaves the outlet

| Sent | Never sent |
| --- | --- |
| Table id, state, confidence, time | Video or frames |
| Camera health (ok, fps, error text) | Camera addresses or passwords |
| One still per request, for drawing zones, with people blurred; deleted by DineOS after a day | Anything that identifies a person |

Put up a notice that cameras are in use. Never point a camera at washrooms, changing or staff rooms.

## Hardware

Any x86 or ARM box with 4 GB RAM runs 2 frames per second on 3 to 4 cameras with the CPU model below (an Intel N100 mini PC or a Raspberry Pi 5 is enough). It needs the same network as the cameras and outbound HTTPS to DineOS; nothing has to be opened on the router.

## Install

```bash
sudo useradd --system --create-home --home-dir /opt/dineos-vision dineos
cd /opt/dineos-vision
python3 -m venv venv
venv/bin/pip install -r requirements.txt
cp -r dineos_vision /opt/dineos-vision/
```

### The model

The worker uses YOLOX-s (Apache-2.0), exported once to ONNX. Do this on any machine and copy the file to `models/yolox_s.onnx`:

```bash
git clone https://github.com/Megvii-BaseDetection/YOLOX && cd YOLOX
pip install -v -e .
# yolox_s.pth from the YOLOX releases page
python tools/export_onnx.py --output-name yolox_s.onnx -n yolox-s -c yolox_s.pth
```

The exported model outputs the raw grid (`1 × 8400 × 85`); the worker decodes it (`detector.decode`). The worker does not download anything at run time.

### Cameras

1. In DineOS, **Settings > Cameras > Add camera box**. Copy the token (shown once).
2. **Add camera** for each camera, with a short stream name such as `courtyard_east`.
3. On the box, give each stream name its RTSP address, either as environment variables or a file:

```bash
# /etc/dineos-vision.env (chmod 600, owned by root)
DINEOS_API_URL=https://api.your-dineos.in
DINEOS_DEVICE_TOKEN=dv_...
DINEOS_MODEL=/opt/dineos-vision/models/yolox_s.onnx
DINEOS_RTSP_COURTYARD_EAST=rtsp://viewer:password@192.168.1.60:554/stream1
```

or `DINEOS_CAMERAS_FILE=/opt/dineos-vision/cameras.json` (see `cameras.example.json`). Use the camera's sub-stream (640 to 1280 px wide); higher resolutions only cost CPU.

4. Check, then run as a service:

```bash
set -a; . /etc/dineos-vision.env; set +a
venv/bin/python -m dineos_vision check      # cloud reachable, each stream readable
sudo cp dineos-vision.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dineos-vision
journalctl -u dineos-vision -f
```

5. Back in DineOS, **Draw table zones** on each camera's picture: outline the table top and the chairs so seated guests fall inside.

## How a state is decided

1. Frames are read at the configured rate (2 per second by default) and the oldest buffered frames are dropped.
2. YOLOX finds people and table things (cup, bowl, bottle, glass, cutlery).
3. A tracker keeps a box only after 3 consecutive frames and through brief misses, so a single false box or a waiter passing does not count.
4. Per zone: someone sitting in it (the lower part of their box overlaps the zone) is **occupied**; nobody but things left on the table is **needs cleaning**; otherwise **vacant**.
5. A new state is sent only after it has held for 25 seconds with at least 80% of frames agreeing. That share is the confidence. The current state is resent every 5 minutes so DineOS knows it is still fresh; a camera that falls silent stops counting after 15 minutes.
6. Readings that cannot be sent wait in memory (up to 2,000) and go out in order when the connection returns.

The settings (fps, hold time, resend interval, minimum confidence) come from DineOS with the zones, so they can be tuned centrally.

## Accuracy and fine-tuning

The pretrained model is a starting point. Before relying on the camera at an outlet, run it for two weeks and check **Reports > Camera**: it compares every reading with whether the till had a visit open at that moment. The target is **95%** agreement for occupied vs vacant (spec §11). Tables with many "people, no visit" readings usually need their zone redrawn, or the camera moved.

To fine-tune on your outlets' views (dim lighting, low tables, plates seen from above):

```bash
# Opt-in, local only: saves a raw frame every 30 s from one camera. Frames contain people:
# keep them on the box or an encrypted drive, label them, then delete them.
venv/bin/python -m dineos_vision collect --camera courtyard_east --every 30 --out /secure/frames
```

Label 1,500 to 3,000 frames across outlets and times of day (persons and table items, COCO names), fine-tune YOLOX-s with the YOLOX training scripts, export to ONNX as above and replace `models/yolox_s.onnx`. Re-run the two-week audit before switching outlets over.

## Development

The core runs and is tested with the standard library only; the detector test also runs when numpy is installed.

```bash
python3 -m unittest discover -s tests -v
```

| Module | Purpose |
| --- | --- |
| `geometry.py` | Point in polygon, zone overlap, IoU |
| `tracking.py` | Detections and the IoU tracker |
| `zones.py` | Zone classification and the hold-before-send debouncer |
| `worker.py` | Frame step and the main loop |
| `cloud.py` | DineOS API client with an offline queue |
| `detector.py` | YOLOX on ONNX Runtime (letterbox, grid decode, NMS) |
| `camera.py` | RTSP reader, stream addresses, the blurred still |
