import json
import os
import subprocess
import tempfile
from PIL import Image

windows = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--class', 'chromium'], timeout=5).decode().splitlines()
if not windows:
    raise RuntimeError('Native Chromium window unavailable')
geometry = subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', windows[0]], timeout=5).decode()
box = {key: int(value) for key, value in (line.split('=', 1) for line in geometry.splitlines()) if key in ['X', 'Y', 'WIDTH', 'HEIGHT']}
fd, path = tempfile.mkstemp(suffix='.png')
os.close(fd)
try:
    subprocess.run(['import', '-window', 'root', path], timeout=10, check=True)
    image = Image.open(path).convert('RGB')
    columns = {}
    for x in range(box['X'] + box['WIDTH'] * 55 // 100, min(image.width, box['X'] + box['WIDTH'])):
        for y in range(max(0, box['Y'] + 48), min(image.height, box['Y'] + 100)):
            r, g, b = image.getpixel((x, y))
            if r > 180 and 70 < g < 180 and b < 140 and r - g > 40:
                columns.setdefault(x, []).append(y)
    groups = []
    for x in sorted(columns):
        if not groups or x - groups[-1][-1] > 3:
            groups.append([])
        groups[-1].append(x)
    matches = []
    for group in groups:
        ys = [y for x in group for y in columns[x]]
        width, height = group[-1] - group[0] + 1, max(ys) - min(ys) + 1
        if 8 <= width <= 24 and 8 <= height <= 24:
            matches.append([(group[0] + group[-1]) // 2, (min(ys) + max(ys)) // 2])
    if len(matches) != 1:
        raise RuntimeError(f'Rendered Bread toolbar glyph is not unique: windows={windows}, geometry={box}, matches={matches}, groups={[(g[0], g[-1]) for g in groups]}')
    print(json.dumps(matches[0]))
finally:
    os.unlink(path)
