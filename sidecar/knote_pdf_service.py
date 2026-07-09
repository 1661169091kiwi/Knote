#!/usr/bin/env python3
"""
Knote PDF layout sidecar
========================
A tiny local HTTP service that runs PaddleOCR / PP-Structure layout analysis on
a page image and returns its data elements (title / text / formula / figure /
table ...) with normalized bounding boxes. Knote's Electron main process spawns
it on 127.0.0.1, and the agent uses it to precisely locate a figure/table on a
PDF page before cropping it out.

Design notes:
- The HTTP server itself uses ONLY the Python standard library, so it *starts*
  even before `pip install paddleocr paddlepaddle`. `/health` reports whether
  PaddleOCR is importable, so the app can guide the user to install it and
  otherwise fall back to the vision-based crop.
- PaddleOCR (heavy: paddlepaddle + models) is imported and initialized LAZILY on
  the first /analyze call, and cached. First call is slow (model download/load).
- Bound to localhost only. A per-launch token (optional, via --token) gates
  requests so nothing else on the machine can drive it.

Endpoints:
  GET  /health              -> {"ok":true,"paddle":bool,"version":str,"ready":bool}
  POST /analyze             -> body {"image_base64": "...", "min_score": 0.5}
                               -> {"ok":true,"width":W,"height":H,
                                   "elements":[{"id","type","bbox":[x0,y0,x1,y1],
                                                "score","text"}]}   (bbox normalized 0..1)
  POST /shutdown            -> graceful stop
"""
import sys
import json
import base64
import argparse
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0.0"

# lazily-initialized PP-Structure engine (None until first successful init)
_engine = None
_engine_lock = threading.Lock()
_engine_error = None  # last init error message, if any
TOKEN = None


def paddle_importable():
    try:
        import paddleocr  # noqa: F401
        return True
    except Exception:
        return False


def get_engine():
    """Import + init PP-Structure once; cache it. Raises on failure."""
    global _engine, _engine_error
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is not None:
            return _engine
        # PaddleOCR reorganized its API across versions; try the known entry
        # points in order so we work on both 2.7.x (PPStructure) and 3.x.
        last = None
        try:
            from paddleocr import PPStructure  # 2.6 - 2.9
            _engine = PPStructure(layout=True, table=True, ocr=True,
                                  show_log=False, lang="ch")
            _engine_error = None
            return _engine
        except Exception as e:  # noqa: BLE001
            last = e
        try:
            # 3.x: layout detection module
            from paddleocr import PPStructureV3  # type: ignore
            _engine = PPStructureV3()
            _engine_error = None
            return _engine
        except Exception as e:  # noqa: BLE001
            last = e
        _engine_error = f"{type(last).__name__}: {last}"
        raise RuntimeError(_engine_error)


# PaddleOCR region labels -> Knote's element vocabulary
TYPE_MAP = {
    "title": "title", "text": "text", "figure": "figure", "figure_caption": "text",
    "table": "table", "table_caption": "text", "header": "text", "footer": "text",
    "reference": "reference", "equation": "formula", "formula": "formula",
    "list": "list", "abstract": "text", "content": "text",
}


def _decode_image(image_b64):
    """base64 (data URL or raw) -> (numpy BGR image, width, height)."""
    import numpy as np
    import cv2
    if "," in image_b64 and image_b64.strip().startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    raw = base64.b64decode(image_b64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    h, w = img.shape[:2]
    return img, w, h


def _extract_items(result):
    """Normalize PP-Structure output (2.x list-of-dicts, or 3.x objects) into
    a flat list of {type_raw, bbox_px:[x0,y0,x1,y1], score, text}."""
    items = []
    # 2.x: result is a list of dicts with 'type','bbox','res'
    if isinstance(result, list):
        for r in result:
            if not isinstance(r, dict):
                continue
            bbox = r.get("bbox")
            if not bbox or len(bbox) < 4:
                continue
            text = ""
            res = r.get("res")
            if isinstance(res, list):
                text = " ".join(str(x.get("text", "")) for x in res if isinstance(x, dict))[:200]
            elif isinstance(res, dict):
                text = str(res.get("html", ""))[:200]
            items.append({
                "type_raw": str(r.get("type", "text")).lower(),
                "bbox_px": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
                "score": float(r.get("score", r.get("confidence", 1.0)) or 1.0),
                "text": text,
            })
    return items


def analyze(image_b64, min_score=0.5):
    engine = get_engine()
    img, w, h = _decode_image(image_b64)
    result = engine(img)
    items = _extract_items(result)
    elements = []
    for i, it in enumerate(items):
        if it["score"] < min_score:
            continue
        x0, y0, x1, y1 = it["bbox_px"]
        elements.append({
            "id": f"e{i + 1}",
            "type": TYPE_MAP.get(it["type_raw"], it["type_raw"] or "text"),
            "bbox": [round(x0 / w, 4), round(y0 / h, 4), round(x1 / w, 4), round(y1 / h, 4)],
            "score": round(it["score"], 3),
            "text": it["text"],
        })
    return {"ok": True, "width": w, "height": h, "elements": elements}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence per-request logging
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        if not TOKEN:
            return True
        return self.headers.get("X-Knote-Token") == TOKEN

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send(200, {
                "ok": True, "version": VERSION,
                "paddle": paddle_importable(),
                "ready": _engine is not None,
                "engine_error": _engine_error,
            })
        else:
            self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self._authed():
            self._send(403, {"ok": False, "error": "forbidden"})
            return
        if path == "/shutdown":
            self._send(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if path != "/analyze":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._send(400, {"ok": False, "error": f"bad_request: {e}"})
            return
        img = payload.get("image_base64")
        if not img:
            self._send(400, {"ok": False, "error": "image_base64 required"})
            return
        if not paddle_importable():
            self._send(200, {
                "ok": False, "error": "paddleocr_not_installed",
                "hint": "在 Knote 的 sidecar 目录运行: pip install -r requirements.txt",
            })
            return
        try:
            self._send(200, analyze(img, float(payload.get("min_score", 0.5))))
        except Exception as e:  # noqa: BLE001
            self._send(200, {"ok": False, "error": f"analyze_failed: {type(e).__name__}: {e}"})


def warmup():
    """Initialize PP-Structure once, which downloads its models — used by the
    one-click installer so the FIRST real analysis isn't a multi-minute
    silent model download. Exits: 0 ok, 1 paddle missing, 2 init failed."""
    if not paddle_importable():
        print("paddleocr 未安装", flush=True)
        return 1
    try:
        print("初始化 PP-Structure（首次会下载模型，可能较大较慢）…", flush=True)
        get_engine()
        print("KNOTE_MODELS_READY 模型已就绪", flush=True)
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"模型初始化失败: {type(e).__name__}: {e}", flush=True)
        return 2


def main():
    global TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)  # 0 = OS-assigned free port
    ap.add_argument("--token", default="")
    ap.add_argument("--warmup", action="store_true")  # pre-download models, then exit
    args = ap.parse_args()
    if args.warmup:
        sys.exit(warmup())
    TOKEN = args.token or None
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    port = server.server_address[1]
    # the parent (Electron) reads this line to learn the chosen port
    print(f"KNOTE_PDF_SIDECAR READY {port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
