import json, os, pathlib, re, subprocess, tempfile, sys
p=pathlib.Path(__file__).parent
e=pathlib.Path(os.environ['PROOF_EVIDENCE']); record=e/'runs.json'
runs=json.loads(record.read_text()) if record.exists() else []
n=len(runs)
assert n<=5
label='baseline' if n==0 else 'closing' if n==5 else f'mutation-{n}'
m=json.loads((p/'source.json').read_text())
expected=m['tree'] if n in (0,5) else json.loads((p/'mutation-trees.json').read_text())[n-1]['source_tree']
with tempfile.TemporaryDirectory() as td:
 env=dict(os.environ,GIT_INDEX_FILE=td+'/index')
 subprocess.run(['git','read-tree','HEAD'],env=env,check=True)
 subprocess.run(['git','add','-u'],env=env,check=True)
 tree=subprocess.check_output(['git','write-tree'],env=env,text=True).strip()
assert tree==expected,(label,tree,expected)
os.utime('src/lib/settings/helpers.ts',None)
command=['yarn','jest','--runTestsByPath','src/lib/settings/helpers.test.ts','src/lib/settings/helpers.capacitor-mirror.test.ts','src/lib/miden/front/NativeNoteAutoConsumeManager.test.tsx','--maxWorkers=2','--json',f'--outputFile={e}/{label}.json']
with (e/f'{label}.log').open('w') as log: result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
data=json.loads((e/f'{label}.json').read_text())
counts={k:data[k] for k in ['numPassedTests','numFailedTests','numPendingTests','numRuntimeErrorTestSuites','numTotalTests','numTotalTestSuites']}
failed=[dict(name=a['fullName'],messages=a.get('failureMessages',[])) for suite in data['testResults'] for a in suite['assertionResults'] if a['status']=='failed']
valid=counts['numTotalTests']==111 and counts['numPassedTests']+counts['numFailedTests']==111 and counts['numRuntimeErrorTestSuites']==0 and counts['numTotalTestSuites']==3
plain=re.sub(r'\x1b\[[0-9;]*m','','\n'.join(m for a in failed for m in a['messages']))
pin='green';prediction=None
if n in (0,5): valid=valid and result.returncode==0 and counts['numFailedTests']==0 and counts['numPassedTests']==111
else:
 valid=valid and result.returncode!=0 and counts['numFailedTests']>0
 if n in (1,3):
  pin='STRUCTURAL ReferenceError only; not functional proof'
  prediction='removed helper definitions leave live callers'
  valid=valid and 'ReferenceError' in plain
 else:
  pin='functional'
  prediction='does not apply an older telemetry write after a completed opt-out of that key' if n==2 else 'keeps a completed telemetry opt-out while a sequential native mirror batch is in flight'
  valid=valid and any(prediction in a['name'] for a in failed) and 'ReferenceError' not in plain and re.search(r'Expected:\s*false',plain) is not None and re.search(r'Received:\s*true',plain) is not None
runs.append(dict(label=label,source_tree=tree,counts=counts,exit_code=result.returncode,pin=pin,prediction=prediction,failed_assertions=failed,valid=bool(valid),command=command))
record.write_text(json.dumps(runs,indent=2)+'\n')
print((e/f'{label}.log').read_text(errors='replace'),end='')
if not valid: print(f'INVALID PROOF: {label}',file=sys.stderr);raise SystemExit(91)
raise SystemExit(result.returncode)
