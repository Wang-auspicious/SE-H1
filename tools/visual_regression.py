"""Frame-accurate reference checks for Homework 1.

Reference MP4 is 1676x1400, CFR 30 fps.  This script extracts exact frame
numbers and compares a browser screenshot directory against them.  Screenshots
must be captured at the same viewport (1676x1400), with browser chrome hidden.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


DEFAULT_FRAMES = [0, 30, 60, 90, 120, 180, 240, 300, 360, 420, 480, 540, 600, 619]


def read(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(path)
    return image


def extract(video: Path, out: Path, frames: list[int]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {video}")
    wanted = set(frames)
    i = 0
    while True:
        ok, image = cap.read()
        if not ok:
            break
        if i in wanted:
            cv2.imwrite(str(out / f"frame_{i:04d}.png"), image)
        i += 1
    cap.release()
    if i != 620:
        raise RuntimeError(f"expected 620 frames, decoded {i}")


def compare(reference: Path, actual: Path, frames: list[int]) -> dict:
    rows = []
    for n in frames:
        a = read(reference / f"frame_{n:04d}.png")
        b = read(actual / f"frame_{n:04d}.png")
        if a.shape != b.shape:
            rows.append({"frame": n, "size": [a.shape, b.shape], "pass": False})
            continue
        delta = cv2.absdiff(a, b)
        gray = cv2.cvtColor(delta, cv2.COLOR_BGR2GRAY)
        rows.append({
            "frame": n,
            "mae": float(delta.mean()),
            "rmse": float(np.sqrt(np.mean(np.square(delta.astype(np.float32))))),
            "changed_pct": float((gray > 8).mean() * 100),
            "pass": bool(delta.mean() <= 3.0 and (gray > 8).mean() <= 0.02),
        })
    return {"viewport": [1676, 1400], "fps": 30, "frames": rows,
            "pass": all(row["pass"] for row in rows)}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--video", type=Path, required=True)
    p.add_argument("--extract", type=Path)
    p.add_argument("--reference", type=Path)
    p.add_argument("--actual", type=Path)
    p.add_argument("--frames", type=int, nargs="+", default=DEFAULT_FRAMES)
    p.add_argument("--report", type=Path, default=Path("visual-regression.json"))
    args = p.parse_args()
    if args.extract:
        extract(args.video, args.extract, args.frames)
    if args.reference and args.actual:
        result = compare(args.reference, args.actual, args.frames)
        args.report.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
        raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
