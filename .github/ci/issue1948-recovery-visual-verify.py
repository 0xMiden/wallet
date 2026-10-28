import hashlib,json,struct
from pathlib import Path
p=Path('proof'); result=json.loads((p/'results.json').read_text())
def specs(s):
 yield from s.get('specs',[])
 for child in s.get('suites',[]): yield from specs(child)
cases=[case for suite in result['suites'] for spec in specs(suite) for case in spec['tests']]
assert len(cases)==6 and all(x['status']=='expected' and len(x['results'])==1 and x['results'][0]['status']=='passed' for x in cases)
surfaces=['extension','mobile','desktop'];themes=['light','dark'];states=['recovery','keyboard-focus','export','export-scrolled','export-delivery','import','import-error','loading','recovery-error','recovery-error-scrolled']
expected={f'{s}-{t}-{v}.png' for s in surfaces for t in themes for v in states}
actual={f.name for f in (p/'screenshots').glob('*.png')};assert actual==expected
files={}
for name in sorted(expected):
 data=(p/'screenshots'/name).read_bytes();assert data[:8]==b'\x89PNG\r\n\x1a\n';w,h=struct.unpack('>II',data[16:24]);assert 0<w<=1800 and 0<h<=1800
 files[name]={'width':w,'height':h,'sha256':hashlib.sha256(data).hexdigest()}
(p/'inventory.json').write_text(json.dumps({'case_count':len(cases),'screenshot_count':len(files),'screenshots':files,'scope':'Synthetic browser fixture; no native or authentication acceptance'},indent=2)+'\n')
