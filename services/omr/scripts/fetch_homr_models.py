"""Download homr's model files with generous timeouts and retries.

homr downloads its models on first use, but its downloader gives up after three 5-second
read timeouts, which breaks Docker builds whenever GitHub's release CDN is slow. This script
fetches the same files the same way homr does (zip per model from the onnx_checkpoints
release, extracted next to the code), so `homr --init` afterwards finds everything in place.

Usage: python fetch_homr_models.py [--gpu]   (--gpu also fetches the fp16 models used on GPUs)
"""

from __future__ import annotations

import os
import sys
import time
import urllib.request
import zipfile

BASE_URL = "https://github.com/liebharc/homr/releases/download/onnx_checkpoints/"


def model_paths(include_gpu: bool) -> list[str]:
    from homr.segmentation.config import segnet_path_onnx, segnet_path_onnx_fp16
    from homr.transformer.configs import default_config

    files = default_config.filepaths
    paths = [segnet_path_onnx, files.encoder_path, files.decoder_path]
    if include_gpu:
        paths += [segnet_path_onnx_fp16, files.encoder_path_fp16, files.decoder_path_fp16]
    return paths


def fetch(url: str, destination: str, attempts: int = 8) -> None:
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=120) as response, open(destination, "wb") as out:
                while chunk := response.read(1 << 20):
                    out.write(chunk)
            return
        except Exception as error:  # noqa: BLE001 - retry on any network error
            print(f"  attempt {attempt}/{attempts} failed: {error}", file=sys.stderr)
            if os.path.exists(destination):
                os.remove(destination)
            time.sleep(min(60, 5 * attempt))
    raise SystemExit(f"Could not download {url}")


def main() -> None:
    include_gpu = "--gpu" in sys.argv[1:]
    for path in model_paths(include_gpu):
        if os.path.exists(path):
            continue
        base = os.path.basename(path).split(".")[0]
        folder = os.path.dirname(path)
        archive = os.path.join(folder, base + ".zip")
        print(f"Downloading {base}", file=sys.stderr)
        fetch(BASE_URL + base + ".zip", archive)
        with zipfile.ZipFile(archive) as zipped:
            zipped.extractall(folder)
        os.remove(archive)
        if not os.path.exists(path):
            raise SystemExit(f"{path} is missing after extracting {archive}")

    # Title detection uses RapidOCR, which downloads its own small models on first use.
    for attempt in range(1, 6):
        try:
            from rapidocr import RapidOCR

            RapidOCR()
            break
        except Exception as error:  # noqa: BLE001
            print(f"  OCR models attempt {attempt}/5 failed: {error}", file=sys.stderr)
            time.sleep(10 * attempt)
    else:
        raise SystemExit("Could not prepare the OCR models")
    print("homr models are ready", file=sys.stderr)


if __name__ == "__main__":
    main()
