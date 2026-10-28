import json, os, pathlib, re, subprocess, tempfile, sys
packet=pathlib.Path(__file__).parent
evidence=pathlib.Path(os.environ['PROOF_EVIDENCE'])
records_path=evidence/'runs.json'
records=json.loads(records_path.read_text()) if records_path.exists() else []
n=len(records)
if n>8: raise SystemExit('unexpected extra invocation')
label='baseline' if n==0 else 'closing' if n==8 else f'mutation-{n}'
source_tree='66d8454d55abe8f950304a5e40569d3daaaa34af'
expected_tree=source_tree if n in (0,8) else json.loads((packet/'mutation-trees.json').read_text())[n-1]['source_tree']
with tempfile.TemporaryDirectory() as td:
    env=dict(os.environ,GIT_INDEX_FILE=td+'/index')
    subprocess.run(['git','read-tree','HEAD'],env=env,check=True)
    subprocess.run(['git','add','-u'],env=env,check=True)
    tree=subprocess.check_output(['git','write-tree'],env=env,text=True).strip()
if tree!=expected_tree: raise SystemExit(f'{label}: source tree mismatch {tree} != {expected_tree}')
os.utime('src/lib/settings/helpers.ts',None)
result_path=evidence/f'{label}.json'
command=['yarn','jest','--runTestsByPath','src/lib/settings/helpers.test.ts','src/lib/miden/front/NativeNoteAutoConsumeManager.test.tsx','--maxWorkers=2','--json',f'--outputFile={result_path}']
log_path=evidence/f'{label}.log'
with log_path.open('w') as log:
    completed=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
result=json.loads(result_path.read_text())
failed=[dict(name=a['fullName'],messages=a.get('failureMessages',[])) for suite in result['testResults'] for a in suite['assertionResults'] if a['status']=='failed']
counts={k:result[k] for k in ['numPassedTests','numFailedTests','numPendingTests','numRuntimeErrorTestSuites','numTotalTests','numTotalTestSuites']}
valid=counts['numPassedTests']+counts['numFailedTests']==106 and counts['numTotalTests']==106 and counts['numRuntimeErrorTestSuites']==0 and counts['numTotalTestSuites']==2
pin='green'
prediction=None
if n in (0,8):
    valid=valid and completed.returncode==0 and counts['numPassedTests']==106 and counts['numFailedTests']==0
else:
    prediction=json.loads((packet/'hunk-predictions.json').read_text())[n-1]
    named=[x.strip() for x in prediction['test'].split(';')]
    valid=valid and completed.returncode!=0 and counts['numFailedTests']>0
    valid=valid and all(any(name in a['name'] for a in failed) for name in named)
    failures='\n'.join(m for a in failed for m in a['messages'])
    plain=re.sub(r'\x1b\[[0-9;]*m','',failures)
    if n==1:
        pin='STRUCTURAL ReferenceError; not functional policy proof'
        valid=valid and 'ReferenceError' in plain and 'invalidValue' in plain
    else:
        pin='functional'
        valid=valid and 'ReferenceError' not in plain and 'Expected' in plain and 'Received' in plain
        if n in (2,3,4,5,6):
            expected='true' if n==2 else 'false'; received='false' if n==2 else 'true'
            valid=valid and re.search(r'Expected:\s*'+expected,plain) is not None and re.search(r'Received:\s*'+received,plain) is not None
records.append(dict(label=label,source_tree=tree,counts=counts,exit_code=completed.returncode,pin=pin,prediction=prediction,failed_assertions=failed,valid=bool(valid),command=command))
records_path.write_text(json.dumps(records,indent=2)+'\n')
print(log_path.read_text(errors='replace'),end='')
if not valid: print(f'INVALID PROOF: {label}',file=sys.stderr); raise SystemExit(91)
raise SystemExit(completed.returncode)
