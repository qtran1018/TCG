#!/usr/bin/env python3
"""
Export the trained YOLO11n card detector to TFLite format for on-device mobile inference.

Run from the project root:
    python scripts/export_yolo_tflite.py

Output:
    mobile/assets/models/card_detector.tflite

After running, install dependencies and rebuild the mobile app:
    cd mobile
    npx expo install react-native-fast-tflite
    npm install jpeg-js
    npm install -D @types/jpeg-js
    npx expo run:android   # or run:ios
"""
import shutil
from pathlib import Path


def main() -> None:
    from ultralytics import YOLO

    src = Path("backend/models/card_detector.pt")
    if not src.exists():
        raise FileNotFoundError(f"Trained model not found: {src}")

    out_dir = Path("mobile/assets/models")
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Exporting {src} → TFLite (float32, imgsz=640)...")
    model = YOLO(str(src))
    export_path = Path(str(model.export(format="tflite", imgsz=640, int8=False, half=False)))

    # Ultralytics creates a _saved_model/ directory containing the .tflite file
    if export_path.is_dir():
        candidates = list(export_path.rglob("*float32.tflite")) or list(export_path.rglob("*.tflite"))
    else:
        candidates = [export_path] if export_path.suffix == ".tflite" else []

    if not candidates:
        raise RuntimeError(f"No .tflite file found under: {export_path}")

    dest = out_dir / "card_detector.tflite"
    shutil.copy2(candidates[0], dest)

    size_mb = dest.stat().st_size / 1024 / 1024
    print(f"Saved: {dest}  ({size_mb:.1f} MB)")
    print()
    print("Next steps:")
    print("  cd mobile")
    print("  npx expo install react-native-fast-tflite")
    print("  npm install jpeg-js")
    print("  npm install -D @types/jpeg-js")
    print("  npx expo run:android   # or run:ios")


if __name__ == "__main__":
    main()
