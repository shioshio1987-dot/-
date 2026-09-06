#!/usr/bin/env python3
"""Iron Cadence のアプリアイコンを生成する。

  python3 tools/make_icons.py

icons/ 配下に PWA / iOS / favicon 用の PNG を書き出す。
デザインはアプリ本体のカラートークンに合わせてある。
"""
import os
from PIL import Image, ImageDraw

BG      = (13, 19, 26)      # --bg2
BG_EDGE = (8, 11, 15)       # --bg
ACC     = (61, 242, 192)    # --acc
ACC2    = (15, 167, 131)    # --acc2
INK     = (233, 241, 247)   # --ink

SS = 4  # スーパーサンプリング倍率


def _radial_glow(size, cx, cy, radius, color, peak):
    """中心が明るい放射グラデーションを RGBA で返す。"""
    glow = Image.new("RGBA", (size, size), color + (0,))
    px = glow.load()
    r2 = radius * radius
    for y in range(size):
        dy = y - cy
        for x in range(size):
            dx = x - cx
            d2 = dx * dx + dy * dy
            if d2 >= r2:
                continue
            t = 1.0 - (d2 / r2) ** 0.5
            px[x, y] = color + (int(peak * t * t),)
    return glow


def render(size, scale=1.0, square=False):
    """バーベルのアイコンを 1 枚描く。

    scale: 図案の縮小率（マスカブル用に安全領域へ収めるときに使う）
    square: True なら角丸なしのベタ塗り（iOS / マスカブル用）
    """
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 背景
    if square:
        d.rectangle([0, 0, S, S], fill=BG)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BG)

    # 下側をわずかに暗くして奥行きを出す
    shade = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for i in range(60):
        a = int(70 * (i / 59) ** 2)
        y0 = S - int(S * 0.55 * (1 - i / 60))
        sd.rectangle([0, y0, S, S], fill=BG_EDGE + (a // 12,))
    img.alpha_composite(Image.composite(shade, Image.new("RGBA", (S, S), (0, 0, 0, 0)), img.split()[3]))

    # アクセントの発光
    glow = _radial_glow(S, S * 0.5, S * 0.30, S * 0.62, ACC, 46)
    img.alpha_composite(Image.composite(glow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), img.split()[3]))

    # バーベル本体
    c = S / 2
    k = scale

    def box(x0, y0, x1, y1, r, fill):
        d.rounded_rectangle(
            [c + x0 * S * k, c + y0 * S * k, c + x1 * S * k, c + y1 * S * k],
            radius=int(r * S * k), fill=fill)

    box(-0.34, -0.028, 0.34, 0.028, 0.028, INK)            # シャフト
    box(-0.28, -0.185, -0.195, 0.185, 0.030, ACC)          # 内側プレート（左）
    box(0.195, -0.185, 0.28, 0.185, 0.030, ACC)            # 内側プレート（右）
    box(-0.40, -0.115, -0.325, 0.115, 0.024, ACC2)         # 外側プレート（左）
    box(0.325, -0.115, 0.40, 0.115, 0.024, ACC2)           # 外側プレート（右）

    return img.resize((size, size), Image.LANCZOS)


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out, exist_ok=True)
    jobs = [
        ("icon-192.png", 192, 1.0, False),
        ("icon-512.png", 512, 1.0, False),
        ("icon-maskable-192.png", 192, 0.72, True),   # 安全領域（中央 80%）に収める
        ("icon-maskable-512.png", 512, 0.72, True),
        ("apple-touch-icon.png", 180, 1.0, True),     # iOS 側で角丸にされる
        ("favicon-32.png", 32, 1.0, False),
        ("favicon-16.png", 16, 1.0, False),
    ]
    for name, size, scale, square in jobs:
        render(size, scale, square).save(os.path.join(out, name), optimize=True)
        print(name, size)


if __name__ == "__main__":
    main()
