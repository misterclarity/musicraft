"""Turning uploads (photos, scans, PDFs) into clean page images for recognition."""

from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
import pypdfium2 as pdfium  # type: ignore[import-untyped]
from PIL import Image, ImageOps

try:  # iPhone photos
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover - optional
    pass

PDF_DPI = 300

Corners = list[tuple[float, float]]


class UnsupportedFile(ValueError):
    """The upload is not an image or PDF we can read."""


def sniff(data: bytes) -> str:
    """Identify a file by its first bytes: 'pdf', 'image' or raise UnsupportedFile."""
    head = data[:16]
    if head.startswith(b"%PDF"):
        return "pdf"
    if (
        head.startswith(b"\xff\xd8\xff")  # JPEG
        or head.startswith(b"\x89PNG\r\n\x1a\n")
        or head[:4] in (b"II*\x00", b"MM\x00*")  # TIFF
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
        or head[:2] == b"BM"
        or head[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1", b"ftypmsf1", b"ftyphevc", b"ftypavif")
    ):
        return "image"
    raise UnsupportedFile("Only images (JPEG, PNG, HEIC, WebP, TIFF) and PDFs can be recognised.")


def pdf_page_count(data: bytes) -> int:
    return len(pdfium.PdfDocument(data))


def render_pdf_page(data: bytes, index: int, dpi: int = PDF_DPI) -> Image.Image:
    pdf = pdfium.PdfDocument(data)
    if not 0 <= index < len(pdf):
        raise UnsupportedFile(f"The PDF has no page {index + 1}.")
    page = pdf[index]
    return page.render(scale=dpi / 72, grayscale=False).to_pil().convert("RGB")


def open_image(data: bytes) -> Image.Image:
    try:
        opened = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(opened)  # honour the camera's rotation
        return image.convert("RGB")
    except Exception as error:  # noqa: BLE001
        raise UnsupportedFile(f"The image could not be read: {error}") from error


def limit_size(image: Image.Image, max_side: int) -> Image.Image:
    longest = max(image.size)
    if longest <= max_side:
        return image
    scale = max_side / longest
    return image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)


def _order_corners(points: np.ndarray) -> np.ndarray:
    """Order four points as top-left, top-right, bottom-right, bottom-left."""
    points = points.reshape(4, 2).astype(np.float32)
    s = points.sum(axis=1)
    d = np.diff(points, axis=1).ravel()
    return np.array(
        [points[np.argmin(s)], points[np.argmin(d)], points[np.argmax(s)], points[np.argmax(d)]],
        dtype=np.float32,
    )


@dataclass
class PageDetection:
    corners: Corners  # normalised 0..1, TL, TR, BR, BL
    confidence: float


def detect_page(image: Image.Image) -> PageDetection | None:
    """Find the sheet of paper in a photo: the largest bright quadrilateral."""
    small = limit_size(image, 1200)
    scale_x = image.width / small.width
    scale_y = image.height / small.height
    gray = cv2.cvtColor(np.asarray(small), cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 40, 120)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area_total = small.width * small.height
    best: np.ndarray | None = None
    best_area = 0.0
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        area = cv2.contourArea(approx)
        if len(approx) == 4 and cv2.isContourConvex(approx) and area > 0.2 * area_total and area > best_area:
            best, best_area = approx, area
    if best is None:
        return None
    ordered = _order_corners(best)
    corners = [(float(x * scale_x / image.width), float(y * scale_y / image.height)) for x, y in ordered]
    return PageDetection(corners=corners, confidence=round(min(1.0, best_area / area_total + 0.2), 2))


def warp(image: Image.Image, corners: Corners) -> Image.Image:
    """Cut out the page given by four normalised corners (TL, TR, BR, BL) and make it rectangular."""
    pts = np.array([(x * image.width, y * image.height) for x, y in corners], dtype=np.float32)
    tl, tr, br, bl = pts
    width = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
    height = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
    if width < 50 or height < 50:
        raise UnsupportedFile("The selected page area is too small.")
    target = np.array([(0, 0), (width - 1, 0), (width - 1, height - 1), (0, height - 1)], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(pts, target)
    warped = cv2.warpPerspective(
        np.asarray(image), matrix, (width, height), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255)
    )
    return Image.fromarray(warped)


def rotate(image: Image.Image, degrees: int) -> Image.Image:
    degrees %= 360
    if degrees == 0:
        return image
    return image.rotate(-degrees, expand=True, fillcolor=(255, 255, 255))


def prepare_page(
    image: Image.Image, *, corners: Corners | None = None, rotation: int = 0, max_side: int = 4000
) -> Image.Image:
    """Crop to the page, rotate and limit the size, ready for recognition.

    Corners refer to the image as uploaded (after the camera's own rotation), so the crop happens
    before the extra rotation chosen in the app.
    """
    if corners:
        image = warp(image, corners)
    image = rotate(image, rotation)
    return limit_size(image, max_side)
