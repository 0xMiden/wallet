import hashlib,json,os,pathlib,subprocess
p=pathlib.Path(__file__).parent;m=json.loads((p/'source.json').read_text());e=pathlib.Path(os.environ['RUNNER_TEMP'])/'retry-status-evidence'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==m['source'] and subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()==m['tree']
for f,h in m['sha256'].items():assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h
out=e/'red.json';cmd=['yarn','jest','--runTestsByPath','src/screens/generating-transaction/GeneratingTransaction.test.tsx','--maxWorkers=2','--json','--outputFile='+str(out)]
with (e/'red.log').open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
x=json.loads(out.read_text());bad=[a for t in x['testResults'] for a in t['assertionResults'] if a['status']=='failed'];summary={'source':m['source'],'tree':m['tree'],'exit':r.returncode,'passed':x['numPassedTests'],'failed':len(bad),'runtime':x['numRuntimeErrorTestSuites'],'names':[a['fullName'] for a in bad]};(e/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print((e/'red.log').read_text(),flush=True)
expected=['reports the reason attached to the displayed status retry refusal','does not report retry evidence from a previous transaction after switching rows','reports a user-triggered raw retry failure on a persisted failed row'];assert r.returncode!=0 and x['numRuntimeErrorTestSuites']==0 and x['numPassedTests']>0 and len(bad)==3
assert all(any(n in a['fullName'] for a in bad) for n in expected)
assert all('expect(' in '\n'.join(a['failureMessages']) and 'TypeError' not in '\n'.join(a['failureMessages']) for a in bad)
for f,h in m['sha256'].items():assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip();summary['verified']=True;(e/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
