import json
import subprocess

import pyatspi

windows = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--class', 'chromium'], timeout=5).decode().splitlines()
if not windows:
    raise RuntimeError('Native Chromium window unavailable')
geometry = subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', windows[0]], timeout=5).decode()
box = {key: int(value) for key, value in (line.split('=', 1) for line in geometry.splitlines()) if key in ['X', 'Y', 'WIDTH', 'HEIGHT']}

matches = []


def visit(node, toolbar=False, page=False, depth=0):
    if depth > 22:
        return
    try:
        role = node.getRoleName()
        toolbar = toolbar or role == 'tool bar'
        page = page or role == 'document web'
        if toolbar and not page and role == 'push button' and (node.name or '').split('\n', 1)[0] == 'Bread':
            if node.getState().contains(pyatspi.STATE_SHOWING):
                rect = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                x, y = rect.x + rect.width // 2, rect.y + rect.height // 2
                if (rect.width > 0 and rect.height > 0 and box['X'] <= x < box['X'] + box['WIDTH']
                        and box['Y'] <= y < box['Y'] + box['HEIGHT']):
                    matches.append([x, y])
        for child in node:
            visit(child, toolbar, page, depth + 1)
    except Exception:
        return


visit(pyatspi.Registry.getDesktop(0))
if len(matches) != 1:
    raise RuntimeError('Rendered Bread toolbar glyph is not unique')
print(json.dumps(matches[0]))
