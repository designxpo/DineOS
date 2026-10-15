import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from dineos_vision.cloud import CloudClient, CloudError
from dineos_vision.tracking import Detection
from dineos_vision.worker import Worker

ZONE_A = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]
ZONE_B = [[0.7, 0.2], [0.95, 0.2], [0.95, 0.6], [0.7, 0.6]]
CONFIG = {
    "device_id": "d",
    "outlet_id": "o",
    "cameras": [
        {
            "id": "cam-1",
            "name": "Courtyard",
            "rtsp_secret_ref": "courtyard",
            "snapshot_requested": True,
            "zones": [{"table_id": "t-a", "label": "A", "polygon": ZONE_A}, {"table_id": "t-b", "label": "B", "polygon": ZONE_B}],
        }
    ],
    "settings": {"fps": 2, "hold_seconds": 25, "resend_seconds": 300, "min_confidence": 0.6},
}
GUEST = Detection("person", 0.9, (300, 50, 450, 450))
PLATE = Detection("bowl", 0.7, (350, 350, 400, 400))


class FakeCloud:
    def __init__(self):
        self.sent = []
        self.stills = []
        self.pending = []

    def send(self, readings):
        self.sent.extend(readings)
        return []

    def upload_snapshot(self, camera_id, jpeg, w, h):
        self.stills.append((camera_id, jpeg, w, h))

    def heartbeat(self, cameras):
        self.beats = cameras


class WorkerTest(unittest.TestCase):
    def run_scene(self, worker, seconds, detections, start):
        readings = []
        for i in range(int(seconds * 2)):
            worker.detector = lambda _frame: list(detections)
            readings += worker.step("cam-1", None, 1000, 1000, t=start + i / 2)
        return readings

    def test_guests_arrive_eat_and_leave_a_mess(self):
        cloud = FakeCloud()
        worker = Worker(cloud, detector=lambda _f: [], still=lambda frame, dets: (b"\xff\xd8jpeg", 640, 360))
        worker.apply_config(CONFIG)
        t0 = 1_760_000_000.0

        empty = self.run_scene(worker, 40, [], t0)
        self.assertEqual({(r["table_id"], r["state"]) for r in empty}, {("t-a", "vacant"), ("t-b", "vacant")})
        # The still for zone drawing went up once, then stopped being wanted.
        self.assertEqual(len(cloud.stills), 1)
        self.assertNotIn("cam-1", worker.snapshot_wanted)

        seated = self.run_scene(worker, 40, [GUEST], t0 + 40)
        self.assertEqual([(r["table_id"], r["state"]) for r in seated], [("t-a", "occupied")])
        # Not before the hold time had passed.
        self.assertGreaterEqual(seated[0]["observed_at"], "2025")
        mess = self.run_scene(worker, 40, [PLATE], t0 + 80)
        self.assertEqual([(r["table_id"], r["state"]) for r in mess], [("t-a", "needs_cleaning")])
        self.assertTrue(all(0.6 <= r["confidence"] <= 1 for r in empty + seated + mess))

    def test_keepalive_resends_every_few_minutes(self):
        worker = Worker(FakeCloud(), detector=lambda _f: [])
        worker.apply_config({**CONFIG, "cameras": [{**CONFIG["cameras"][0], "snapshot_requested": False}]})
        readings = self.run_scene(worker, 700, [], 1_760_000_000.0)
        per_table = [r for r in readings if r["table_id"] == "t-a"]
        self.assertEqual(len(per_table), 3)  # first decision, then two resends in ~11 minutes

    def test_zone_changes_reset_and_removed_cameras_go(self):
        worker = Worker(FakeCloud(), detector=lambda _f: [])
        worker.apply_config(CONFIG)
        self.run_scene(worker, 40, [], 1_760_000_000.0)
        self.assertEqual(set(worker.cameras["cam-1"].debouncers), {"t-a", "t-b"})
        cam = {**CONFIG["cameras"][0], "zones": CONFIG["cameras"][0]["zones"][:1]}
        worker.apply_config({**CONFIG, "cameras": [cam]})
        self.assertEqual(set(worker.cameras["cam-1"].debouncers), {"t-a"})
        worker.apply_config({**CONFIG, "cameras": []})
        self.assertEqual(worker.cameras, {})


class Recorder(BaseHTTPRequestHandler):
    requests = []

    def _handle(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        Recorder.requests.append((self.command, self.path, self.headers.get("authorization"), self.headers.get("content-type"), body))
        if self.path.startswith("/v1/vision/config"):
            payload = json.dumps(CONFIG).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path.startswith("/v1/vision/table-state"):
            n = len(json.loads(body)["readings"])
            payload = json.dumps({"results": [{"result": "applied"}] * n}).encode()
            self.send_response(200)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(204)
            self.end_headers()

    do_GET = do_POST = do_PUT = _handle

    def log_message(self, *_args):
        pass


class CloudClientTest(unittest.TestCase):
    def test_talks_to_dineos_and_queues_through_an_outage(self):
        Recorder.requests = []
        server = HTTPServer(("127.0.0.1", 0), Recorder)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            cloud = CloudClient(f"http://127.0.0.1:{port}", "dv_test", timeout=2)
            self.assertEqual(cloud.config()["cameras"][0]["id"], "cam-1")
            cloud.upload_snapshot("cam-1", b"\xff\xd8x", 640, 360)
            method, path, auth, ctype, body = Recorder.requests[-1]
            self.assertEqual((method, path, auth, ctype, body), ("PUT", "/v1/vision/cameras/cam-1/snapshot?width=640&height=360", "Bearer dv_test", "image/jpeg", b"\xff\xd8x"))

            offline = CloudClient("http://127.0.0.1:1", "dv_test", timeout=1)
            reading = {"table_id": "t-a", "state": "occupied", "confidence": 0.9, "observed_at": "2026-10-15T12:00:00+00:00"}
            with self.assertRaises(CloudError):
                offline.send([reading])
            self.assertEqual(len(offline.pending), 1)
            offline.api_url = f"http://127.0.0.1:{port}"
            offline.send([{**reading, "state": "vacant"}])
            self.assertEqual(len(offline.pending), 0)
            sent = json.loads(Recorder.requests[-1][4])["readings"]
            self.assertEqual([r["state"] for r in sent], ["occupied", "vacant"])
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
