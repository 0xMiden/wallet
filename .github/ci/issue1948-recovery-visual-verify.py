import json,struct,hashlib
from pathlib import Path
p=Path('proof');behavior=json.loads((p/'behavior.json').read_text());assert behavior['numPassedTests']==1 and behavior['numFailedTests']==behavior['numPendingTests']==behavior['numRuntimeErrorTestSuites']==0
result=json.loads((p/'results.json').read_text());assert result['stats']['expected']==2 and result['stats']['skipped']==result['stats']['unexpected']==result['stats']['flaky']==0
files={}
for theme in ['light','dark']:
 n=f'extension-{theme}-unscrolled-error.png';b=(p/'screenshots'/n).read_bytes();w,h=struct.unpack('>II',b[16:24]);assert (w,h)==(360,640);files[n]=hashlib.sha256(b).hexdigest()
(p/'inventory.json').write_text(json.dumps({'cases':2,'screenshots':files},indent=2)+'\n')
