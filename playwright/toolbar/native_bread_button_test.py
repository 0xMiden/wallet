import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from PIL import Image, ImageDraw

SCRIPT = Path(__file__).with_name('native-bread-button.py').resolve()


class NativeBreadButtonTest(unittest.TestCase):
    def locate(self, points):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new('RGB', (1600, 1100), 'white')
            painter = ImageDraw.Draw(image)
            for x, y in points:
                painter.rectangle((x - 5, y - 5, x + 5, y + 5), fill=(230, 120, 40))
            image.save(root / 'screen.png')
            (root / 'xdotool').write_text("#!/bin/sh\ncase \"$1\" in\nsearch) echo 123;;\ngetwindowgeometry) printf 'X=10\\nY=10\\nWIDTH=1400\\nHEIGHT=1000\\n';;\nesac\n")
            (root / 'import').write_text('#!/bin/sh\ncp "$PROBE_SCREEN" "$3"\n')
            for name in ('xdotool', 'import'):
                (root / name).chmod(0o755)
            env = {**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}', 'PROBE_SCREEN': str(root / 'screen.png')}
            return subprocess.run(['/usr/bin/python3', str(SCRIPT)], capture_output=True, text=True, env=env)

    def test_page_decoy_is_not_a_toolbar_candidate(self):
        result = self.locate([(1260, 72), (944, 105)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [1260, 72])

    def test_ambiguous_toolbar_candidates_fail_closed(self):
        result = self.locate([(1230, 72), (1260, 72)])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not unique', result.stderr)


if __name__ == '__main__':
    unittest.main()
