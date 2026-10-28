import hashlib,json,os,pathlib,re,subprocess
packet=pathlib.Path(__file__).parent
m=json.loads((packet/'source.json').read_text())
e=pathlib.Path(os.environ['RUNNER_TEMP'])/'d2-producer-evidence'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==m['source']
assert subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()==m['tree']
for f,h in m['file_sha256'].items(): assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h
out=e/'red.json';cmd=['yarn','jest','--runTestsByPath',*m['suites'],'--maxWorkers=2','--json','--outputFile='+str(out)]
with (e/'red.log').open('w') as log: r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
x=json.loads(out.read_text());failed=[a for t in x['testResults'] for a in t['assertionResults'] if a['status']=='failed']
allowed=[r'^user-visible bridge deposit producers ']
messages='\n'.join(s for a in failed for s in a['failureMessages'])
summary={'source':m['source'],'tree':m['tree'],'command':cmd,'exit':r.returncode,'total':x['numTotalTests'],'passed':x['numPassedTests'],'failed':x['numFailedTests'],'runtime':x['numRuntimeErrorTestSuites'],'failed_names':[a['fullName'] for a in failed]}
(e/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print((e/'red.log').read_text(),flush=True)
assert len(x['testResults'])==len(m['suites']) and x['numTotalTests']>13
assert r.returncode!=0 and x['numRuntimeErrorTestSuites']==0 and x['numFailedTests']==13 and len(failed)==13
assert all(any(re.search(p,a['fullName']) for p in allowed) for a in failed)
assert 'ReferenceError' not in messages and 'TypeError' not in messages
assert subprocess.check_output(['git','status','--porcelain'],text=True).strip()==''
summary['verified']=True
(e/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
