import json,struct,hashlib
from pathlib import Path
p=Path('proof');d=json.loads((p/'results.json').read_text());assert d['stats']['expected']==1 and d['stats']['unexpected']==d['stats']['skipped']==d['stats']['flaky']==0
s=p/'screenshots';observation=json.loads((s/'readiness.json').read_text());assert set(observation)=={'before','unavailableIdle','immediate','settled'}
files={}
for n in ['ios-readiness-immediate.png','ios-readiness-settled.png']:
 b=(s/n).read_bytes();w,h=struct.unpack('>II',b[16:24]);assert 0<w<=1800 and 0<h<=1800;files[n]={'width':w,'height':h,'sha256':hashlib.sha256(b).hexdigest()}
(p/'readiness-inventory.json').write_text(json.dumps({'cases':1,'screenshots':files,'scope':'synthetic readiness observation, no UI acceptance'},indent=2)+'\n')
