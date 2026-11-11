#!/usr/bin/env python3
"""marohwp 아이콘 생성기.

파란 원 안에 흰색 굵은 글씨 "HWP" (원 바깥은 투명).

    python3 scripts/make_icon.py

출력물 (모두 저장소에 커밋):
    build/icon.ico      16, 24, 32, 48, 64, 128, 256 px (256 은 PNG, 나머지는 32비트 BMP)
    build/icon.png      512 x 512
    build/icon-256.png  256 x 256 (실행 중 창 아이콘으로도 사용)

크기마다 고해상도로 따로 그린 뒤 줄여서(슈퍼샘플링) 작은 크기에서도 글자가
뭉개지지 않게 한다. 작은 크기일수록 글자를 조금 더 크고 굵게 그린다.
Pillow 만 사용하며 결과는 재현 가능하다(같은 Pillow/폰트면 같은 바이트).
"""
from __future__ import annotations

import io
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(ROOT, "build")

BLUE = (0x19, 0x76, 0xD2, 255)  # #1976D2
WHITE = (255, 255, 255, 255)
TEXT = "HWP"
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)

FONT_DIR = "/usr/share/fonts/opentype/inter"
# (굵기 이름, 후보 경로) — 앞에서부터 존재하는 첫 폰트를 쓴다.
FONT_CANDIDATES = {
    "bold": [
        os.path.join(FONT_DIR, "Inter-Bold.otf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ],
    "extrabold": [
        os.path.join(FONT_DIR, "Inter-ExtraBold.otf"),
        os.path.join(FONT_DIR, "Inter-Bold.otf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ],
}


def find_font(weight: str) -> str:
    for path in FONT_CANDIDATES[weight]:
        if os.path.exists(path):
            return path
    raise SystemExit("굵은 산세리프 폰트를 찾을 수 없습니다: %s" % FONT_CANDIDATES[weight])


def style_for(size: int) -> dict:
    """크기별 글자 모양: 글자 폭(원 지름 대비), 자간(em), 굵기."""
    if size <= 16:
        return {"width": 0.90, "tracking": 0.05, "weight": "extrabold"}
    if size <= 24:
        return {"width": 0.86, "tracking": 0.035, "weight": "extrabold"}
    if size <= 48:
        return {"width": 0.82, "tracking": 0.02, "weight": "extrabold"}
    return {"width": 0.76, "tracking": 0.0, "weight": "bold"}


def measure(font: ImageFont.FreeTypeFont, tracking_px: float):
    """글자를 하나씩 놓았을 때의 (펜 위치들, 잉크 왼쪽, 잉크 오른쪽, 잉크 위, 잉크 아래)."""
    pens = []
    x = 0.0
    left = top = float("inf")
    right = bottom = float("-inf")
    for i, ch in enumerate(TEXT):
        pens.append(x)
        l, t, r, b = font.getbbox(ch, anchor="ls")  # 기준선 원점
        left = min(left, x + l)
        right = max(right, x + r)
        top = min(top, t)
        bottom = max(bottom, b)
        x += font.getlength(ch)
        if i < len(TEXT) - 1:
            x += tracking_px
    return pens, left, right, top, bottom


def render(size: int) -> Image.Image:
    """size x size RGBA 아이콘 한 장."""
    scale = max(4, -(-2048 // size))  # 최소 2048px 캔버스에서 그린 뒤 축소
    big = size * scale
    style = style_for(size)
    font_path = find_font(style["weight"])

    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # 원: 가장자리 안티앨리어싱이 잘리지 않도록 캔버스에 꽉 채우되 1 출력픽셀의 1/4 여백
    pad = scale / 4.0
    draw.ellipse((pad, pad, big - 1 - pad, big - 1 - pad), fill=BLUE)

    # 목표 글자 폭에 맞는 폰트 크기를 찾는다.
    target_w = (big - 2 * pad) * style["width"]
    probe = ImageFont.truetype(font_path, 1000)
    _, l0, r0, _, _ = measure(probe, style["tracking"] * 1000)
    font_px = max(1, int(round(1000 * target_w / (r0 - l0))))
    font = ImageFont.truetype(font_path, font_px)
    pens, left, right, top, bottom = measure(font, style["tracking"] * font_px)

    # 잉크 상자의 중심을 원의 중심에 맞춘다(대문자뿐이라 시각적 중심과 같다).
    cx = cy = (big - 1) / 2.0
    origin_x = cx - (left + right) / 2.0
    baseline_y = cy - (top + bottom) / 2.0
    for ch, pen in zip(TEXT, pens):
        draw.text((origin_x + pen, baseline_y), ch, font=font, fill=WHITE, anchor="ls")

    return img.resize((size, size), Image.LANCZOS)


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def dib_bytes(img: Image.Image) -> bytes:
    """ICO 용 32비트 BGRA DIB (BITMAPINFOHEADER + XOR 비트맵 + 1비트 AND 마스크)."""
    w, h = img.size
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = img.load()
    xor = bytearray()
    and_row_len = ((w + 31) // 32) * 4
    and_mask = bytearray()
    for y in range(h - 1, -1, -1):  # 아래에서 위로
        row_mask = bytearray(and_row_len)
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
            if a == 0:
                row_mask[x // 8] |= 0x80 >> (x % 8)
        and_mask += row_mask
    return header + bytes(xor) + bytes(and_mask)


def write_ico(path: str, images: dict[int, Image.Image]) -> None:
    entries = []
    for size in sorted(images):
        img = images[size]
        data = png_bytes(img) if size >= 256 else dib_bytes(img)
        entries.append((size, data))
    out = bytearray(struct.pack("<HHH", 0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    for size, data in entries:
        dim = 0 if size >= 256 else size
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in entries:
        out += data
    with open(path, "wb") as f:
        f.write(out)


def main() -> int:
    os.makedirs(BUILD_DIR, exist_ok=True)
    images = {size: render(size) for size in sorted(set(ICO_SIZES) | {512})}

    write_ico(os.path.join(BUILD_DIR, "icon.ico"), {s: images[s] for s in ICO_SIZES})
    for name, size in (("icon.png", 512), ("icon-256.png", 256)):
        with open(os.path.join(BUILD_DIR, name), "wb") as f:
            f.write(png_bytes(images[size]))

    for name in ("icon.ico", "icon.png", "icon-256.png"):
        p = os.path.join(BUILD_DIR, name)
        print("%-14s %7d bytes" % (name, os.path.getsize(p)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
