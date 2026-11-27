#!/usr/bin/env python3
"""Builds the prototype as self-contained HTML files that open by double-click.

Usage (from the wallet repository root):
    python3 playwright/visual/success-screens/build-single.py

Writes two files into ~/Desktop/CLAUDE/bread-send-prototype/ :
    bread-prototype.html   every tab: all flow versions, option rounds, comparisons, app screens
    bread-send-flow.html   only the current Send flow, no tab bar

It runs the single-file vite build (vite.single.config.mts), then pastes the script and stylesheet
into one HTML page, inlines the token logos (which the app normally fetches from the token list on
GitHub) and, for the full file, embeds the two comparison pages with their images. The results need
no server and no network.
"""
import base64
import json
import mimetypes
import os
import re
import subprocess
import tempfile
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PROJECT = os.path.expanduser('~/Desktop/CLAUDE/bread-send-prototype')

with tempfile.TemporaryDirectory() as build:
    subprocess.run(
        ['yarn', '-s', 'vite', 'build', '--config', 'playwright/visual/success-screens/vite.single.config.mts'],
        cwd=REPO, env={**os.environ, 'SINGLE_OUT': build}, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    js = open(os.path.join(build, 'single.js'), encoding='utf-8').read()
    css = open(os.path.join(build, 'single.css'), encoding='utf-8').read()

# The token logos: fetch each once and embed it, so the file shows them offline.
inlined = 0
for url in sorted(set(re.findall(r'https://raw\.githubusercontent\.com/0xMiden/token-list/main/logos/[a-z0-9]+/logo\.png', js))):
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            data = base64.b64encode(response.read()).decode()
        js = js.replace(url, 'data:image/png;base64,' + data)
        inlined += 1
    except Exception as error:  # A logo that cannot be fetched keeps its URL and loads online.
        print(f'logo not inlined ({error}): {url}')

# A literal closing tag inside the script or stylesheet would end the element early.
js = js.replace('</script', '<\\/script')
css = css.replace('</style', '<\\/style')

# The comparison pages, each with its images embedded.
compare = {}
compare_dir = os.path.join(PROJECT, 'compare')
for name in sorted(os.listdir(compare_dir)):
    if not name.endswith('.html'):
        continue
    page = open(os.path.join(compare_dir, name), encoding='utf-8').read()

    def embed(match):
        path = os.path.join(compare_dir, match.group(1))
        if not os.path.isfile(path):
            return match.group(0)
        kind = mimetypes.guess_type(path)[0] or 'image/webp'
        return 'src="data:%s;base64,%s"' % (kind, base64.b64encode(open(path, 'rb').read()).decode())

    compare[name] = re.sub(r'src="([^":]+\.(?:png|webp|jpg|jpeg))"', embed, page)
compare_json = json.dumps(compare).replace('</', '<\\/')


def write(filename, mode, title, extra=''):
    html = (
        '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n'
        '    <meta name="viewport" content="width=device-width,initial-scale=1" />\n'
        f'    <title>{title}</title>\n    <style id="bread-css">{css}</style>\n  </head>\n'
        '  <body style="margin: 0">\n    <div id="root"></div>\n'
        f'    <script>window.__BREAD_SINGLE__ = "{mode}";</script>\n{extra}'
        f'    <script type="module" id="bread-js">{js}</script>\n  </body>\n</html>\n'
    )
    out = os.path.join(PROJECT, filename)
    open(out, 'w', encoding='utf-8').write(html)
    print(f'{out}  ({len(html) / 1e6:.1f} MB)')


os.makedirs(PROJECT, exist_ok=True)
write('bread-prototype.html', 'all', 'Bread · Send prototype', f'    <script type="application/json" id="bread-compare">{compare_json}</script>\n')
write('bread-send-flow.html', 'flow', 'Bread · Send flow prototype')
print(f'{inlined} logos inlined, {len(compare)} comparison pages embedded')
