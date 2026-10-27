#!/usr/bin/env python3
"""只读取PNG透明度和坐标，生成CSS嘴型裁切元数据；不修改或重绘任何图片。"""
import hashlib
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "static/portrait/assets"
LABELS = "calm happy curious shy excited surprised laugh worried sad angry".split()
anchors = json.loads((ASSETS / "mouth-anchors.json").read_text())
manifest = {"version": 4, "width": 1024, "height": 1536, "style": "bocchi-inspired-cel-anime", "emotions": {}}
report = []
for label in LABELS:
    body_path, mouth_path = ASSETS / "portraits" / f"{label}.png", ASSETS / "mouths" / f"{label}.png"
    body, mouth = Image.open(body_path), Image.open(mouth_path)
    assert body.size == (1024, 1536), (label, body.size)
    for im in (body, mouth):
        assert im.mode == "RGBA", (label, im.mode)
        hist = im.getchannel("A").histogram()
        assert hist[0] > im.width * im.height * .12, f"missing transparent background: {label}"
        assert sum(hist[220:]) > 200, f"empty or translucent asset: {label}"
    width, height = mouth.size
    alpha = mouth.getchannel("A")
    frames = []
    for index in range(3):
        left, right = round(width * index / 3), round(width * (index + 1) / 3)
        # 阈值仅用于计算位置，消费的图片仍然是未经处理的原始 PNG。
        bbox = alpha.crop((left, 0, right, height)).point(lambda a: 255 if a > 24 else 0).getbbox()
        assert bbox, (label, index)
        x0, y0, x1, y1 = bbox
        x0, y0 = max(0, x0 - 3), max(0, y0 - 3)
        x1, y1 = min(right - left, x1 + 3), min(height, y1 + 3)
        frames.append([left + x0, y0, x1 - x0, y1 - y0])
    manifest["emotions"][label] = {
        "body": f"/assets/portraits/{label}.png?v={hashlib.sha256(body_path.read_bytes()).hexdigest()[:12]}",
        "anchor": anchors[label],
        "mouth": {"image": f"/assets/mouths/{label}.png?v={hashlib.sha256(mouth_path.read_bytes()).hexdigest()[:12]}", "width": width, "height": height,
                  "referenceWidth": max(rect[2] for rect in frames), "frames": frames},
    }
    report.append({"emotion": label, "portrait": list(body.size), "mouth": list(mouth.size), "frames": frames, "anchor": anchors[label],
                   "body_sha256": hashlib.sha256(body_path.read_bytes()).hexdigest(),
                   "mouth_sha256": hashlib.sha256(mouth_path.read_bytes()).hexdigest()})
(ASSETS / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
(ROOT / "ASSET-VERIFICATION.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(f"Validated {len(LABELS)} transparent mouthless portraits and {len(LABELS) * 3} mouth frames.")
