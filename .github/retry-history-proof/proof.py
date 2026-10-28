import hashlib,json,os,pathlib,subprocess
p=pathlib.Path(__file__).parent;m=json.loads((p/'source.json').read_text()); e=pathlib.Path(os.environ['RUNNER_TEMP'])/'retry-history-evidence'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==m['source']
assert subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()==m['tree']
for f,h in m['sha256'].items(): assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h
suites=['src/app/templates/history/HistoryDetails.test.tsx','src/app/templates/history/SwapDetail.test.tsx']; out=e/'red.json'
cmd=['yarn','jest','--runTestsByPath',*suites,'--maxWorkers=2','--json','--outputFile='+str(out)]
with (e/'red.log').open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
x=json.loads(out.read_text()); failed=[a for t in x['testResults'] for a in t['assertionResults'] if a['status']=='failed']
summary={'source':m['source'],'tree':m['tree'],'exit':r.returncode,'passed':x['numPassedTests'],'failed':x['numFailedTests'],'runtime':x['numRuntimeErrorTestSuites'],'failed_names':[a['fullName'] for a in failed]};(e/'summary.json').write_text(json.dumps(summary,indent=2)+'\n'); print((e/'red.log').read_text(),flush=True)
expected=['reports a live retry failure with a closed producer identity, branch 0','reports the primary retry reason owned by the displayed error after dwell','reports the Earn receive retry origin for the displayed refusal','reports the payout retry reason on the visible notice']
assert r.returncode!=0 and x['numRuntimeErrorTestSuites']==0 and x['numPassedTests']>0 and len(failed)==4
assert all(any(n in a['fullName'] for a in failed) for n in expected)
assert all('toHaveBeenCalledWith' in '\n'.join(a['failureMessages']) for a in failed)
for f,h in m['sha256'].items(): assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
summary['verified']=True;(e/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
