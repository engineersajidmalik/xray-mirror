"""Writes test-media/face.y4m: a portrait that slowly moves, tilts and zooms.

Chrome can play it as a fake webcam (--use-file-for-fake-video-capture), which
lets the end-to-end test run without a real camera.
Usage: python tools/make-test-video.py <portrait.jpg>
"""
import sys
from pathlib import Path

import cv2
import numpy as np

W, H, FPS, SECONDS = 640, 480, 30, 6
src = cv2.imread(sys.argv[1])
if src is None:
    sys.exit(f"Could not read {sys.argv[1]}")
face = cv2.resize(src, (int(src.shape[1] * 380 / src.shape[0]), 380))
canvas = np.full((H, W, 3), 40, np.uint8)
x0 = (W - face.shape[1]) // 2
canvas[50:430, x0:x0 + face.shape[1]] = face

out = Path(__file__).resolve().parent.parent / "test-media" / "face.y4m"
with open(out, "wb") as f:
    f.write(f"YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n".encode())
    n = FPS * SECONDS
    for i in range(n):
        t = i / n * 2 * np.pi
        m = cv2.getRotationMatrix2D((W / 2, H / 2), 14 * np.sin(t), 1.0 + 0.12 * np.sin(2 * t))
        m[:, 2] += (40 * np.sin(t), 15 * np.cos(t))
        frame = cv2.warpAffine(canvas, m, (W, H), borderValue=(40, 40, 40))
        f.write(b"FRAME\n" + cv2.cvtColor(frame, cv2.COLOR_BGR2YUV_I420).tobytes())
print(f"Wrote {out} ({n} frames)")
