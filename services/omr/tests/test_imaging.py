import io

import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw

from musicraft_omr.imaging import (
    UnsupportedFile,
    detect_page,
    limit_size,
    pdf_page_count,
    prepare_page,
    render_pdf_page,
    sniff,
    warp,
)


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def pdf_bytes(pages: int) -> bytes:
    images = [Image.new("RGB", (595, 842), "white") for _ in range(pages)]
    buffer = io.BytesIO()
    images[0].save(buffer, "PDF", save_all=True, append_images=images[1:], resolution=72)
    return buffer.getvalue()


def photo_of_page() -> tuple[Image.Image, list[tuple[float, float]]]:
    """A white sheet with staff-like lines, photographed at an angle on a dark table."""
    page = Image.new("RGB", (800, 1100), "white")
    draw = ImageDraw.Draw(page)
    for staff in range(8):
        for line in range(5):
            y = 120 + staff * 110 + line * 12
            draw.line([(60, y), (740, y)], fill="black", width=2)
    corners = np.float32([[200, 150], [1000, 210], [960, 1350], [150, 1300]])
    matrix = cv2.getPerspectiveTransform(np.float32([[0, 0], [800, 0], [800, 1100], [0, 1100]]), corners)
    photo = cv2.warpPerspective(np.asarray(page), matrix, (1200, 1500), borderValue=(40, 40, 45))
    expected = [(x / 1200, y / 1500) for x, y in corners]
    return Image.fromarray(photo), expected


def test_sniff_accepts_images_and_pdfs_only():
    assert sniff(png_bytes(Image.new("RGB", (4, 4)))) == "image"
    assert sniff(pdf_bytes(1)) == "pdf"
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4)).save(buffer, "JPEG")
    assert sniff(buffer.getvalue()) == "image"
    with pytest.raises(UnsupportedFile):
        sniff(b"<?xml version='1.0'?><score-partwise/>")


def test_pdf_pages_render_at_300_dpi():
    data = pdf_bytes(2)
    assert pdf_page_count(data) == 2
    page = render_pdf_page(data, 1)
    assert abs(page.width - 2480) <= 2 and abs(page.height - 3508) <= 2
    with pytest.raises(UnsupportedFile):
        render_pdf_page(data, 5)


def test_detects_the_page_in_a_photo():
    photo, expected = photo_of_page()
    found = detect_page(photo)
    assert found is not None
    for (x, y), (ex, ey) in zip(found.corners, expected, strict=True):
        assert abs(x - ex) < 0.03 and abs(y - ey) < 0.03


def test_warp_straightens_the_page():
    photo, expected = photo_of_page()
    page = warp(photo, expected)
    assert 750 < page.width < 900 and 1050 < page.height < 1200
    # The straightened page is mostly white.
    assert np.asarray(page.convert("L")).mean() > 200


def test_prepare_page_rotates_and_limits_size():
    image = Image.new("RGB", (5000, 3000), "white")
    prepared = prepare_page(image, rotation=90, max_side=4000)
    assert prepared.size == (2400, 4000)
    assert limit_size(Image.new("RGB", (100, 50)), 4000).size == (100, 50)
