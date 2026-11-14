# /// script
# dependencies = ["pillow"]
# ///
"""Frosted-glass background for Herdr's neon layout, from your own wallpaper.

    uv run scripts/herdr-background.py            # the current macOS wallpaper
    uv run scripts/herdr-background.py photo.jpg  # any image

Crops it to your screen's shape (like macOS "fill screen"), blurs and darkens it so text
stays readable, saves ~/.config/herdr-app/backgrounds/glass-<n>.jpg and points the neon
layout at it (a new name each time: Herdr caches images by path).
"""
import json, os, re, subprocess, sys, time
from PIL import Image, ImageEnhance, ImageFilter

home = os.environ.get("HERDR_APP_HOME", os.path.expanduser("~/.config/herdr-app"))
src = sys.argv[1] if len(sys.argv) > 1 else subprocess.run(
    ["osascript", "-e", 'tell application "System Events" to get picture of current desktop'],
    capture_output=True, text=True, check=True).stdout.strip()

# The main screen's shape, e.g. 2560 x 1600 -> 1.6.
out = subprocess.run(["system_profiler", "SPDisplaysDataType"], capture_output=True, text=True).stdout
m = re.search(r"Resolution: (\d+) x (\d+)", out)
ratio = int(m[1]) / int(m[2]) if m else 16 / 10

im = Image.open(src).convert("RGB")
w, h = im.size
if w / h > ratio:
    cw = int(h * ratio); im = im.crop(((w - cw) // 2, 0, (w - cw) // 2 + cw, h))
else:
    ch = int(w / ratio); im = im.crop((0, (h - ch) // 2, w, (h - ch) // 2 + ch))
im = im.resize((2880, int(2880 / ratio)), Image.LANCZOS).filter(ImageFilter.GaussianBlur(28))
im = ImageEnhance.Brightness(ImageEnhance.Color(im).enhance(0.85)).enhance(0.55)

name = f"backgrounds/glass-{int(time.time())}.jpg"
os.makedirs(os.path.join(home, "backgrounds"), exist_ok=True)
im.save(os.path.join(home, name), quality=90)

layout = os.path.join(home, "layouts", "neon.json")
if os.path.exists(layout):
    data = json.load(open(layout))
    data["background"] = {"image": name, "fit": "cover"}
    open(layout, "w").write(json.dumps(data, indent=2) + "\n")
print(f"saved {name}" + (" and updated layouts/neon.json" if os.path.exists(layout) else ""))
