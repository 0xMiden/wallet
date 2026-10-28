import json,struct,hashlib
from pathlib import Path
p=Path('proof');d=json.loads((p/'results.json').read_text());assert d['stats']['expected']==1 and d['stats']['unexpected']==d['stats']['skipped']==d['stats']['flaky']==0
s=p/'screenshots';o=json.loads((s/'readiness.json').read_text());assert set(o)=={'before','immediate','oneSecond','settled'}
b=(s/'android-readiness.png').read_bytes();assert b[:8]==b'\x89PNG\r\n\x1a\n';w,h=struct.unpack('>II',b[16:24]);assert 0<w<=1800 and 0<h<=1800
(p/'readiness-inventory.json').write_text(json.dumps({'cases':1,'dimensions':[w,h],'screenshot_sha256':hashlib.sha256(b).hexdigest(),'scope':'Sanitized synthetic state observation only'},indent=2)+'\n')
