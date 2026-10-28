import json
from pathlib import Path
p=Path('proof'); result=json.loads((p/'results.json').read_text())
def specs(s):
 yield from s.get('specs',[])
 for child in s.get('suites',[]): yield from specs(child)
cases=[case for suite in result['suites'] for spec in specs(suite) for case in spec['tests']]
assert len(cases)==1 and all(x['status']=='expected' and len(x['results'])==1 and x['results'][0]['status']=='passed' for x in cases)
(p/'inventory.json').write_text(json.dumps({'case_count':1,'purpose':'Fixture callback identity diagnostic; no visual or native acceptance'},indent=2)+'\n')
