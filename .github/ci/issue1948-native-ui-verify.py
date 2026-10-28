import hashlib,json,os,struct
from pathlib import Path
p=Path('proof');platform=os.environ['NATIVE_UI_PLATFORM'];d=json.loads((p/'results.json').read_text());assert d['stats']['expected']==1 and d['stats']['unexpected']==d['stats']['skipped']==d['stats']['flaky']==0
files={}
for theme in ['light','dark']:
 for state in ['recovery','error','export']:
  n=f'{platform}-{theme}-{state}.png';b=(p/'screenshots'/n).read_bytes();assert b[:8]==b'\x89PNG\r\n\x1a\n';w,h=struct.unpack('>II',b[16:24]);assert 0<w<=1800 and 0<h<=1800;files[n]={'width':w,'height':h,'sha256':hashlib.sha256(b).hexdigest()}
assert len(list((p/'screenshots').glob('*.png')))==6
(p/'native-ui-inventory.json').write_text(json.dumps({'cases':1,'platform':platform,'screenshots':files,'scope':'Synthetic state and native taps; not backend recovery, authentication or file sharing'},indent=2)+'\n')
