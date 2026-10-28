import hashlib,json,os,pathlib,subprocess
p=pathlib.Path(__file__).parent;m=json.loads((p/'source.json').read_text());e=pathlib.Path(os.environ['RUNNER_TEMP'])/'retry-status-green-evidence';assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==m['source'] and subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()==m['tree']
def hashes():
 for f,h in m['sha256'].items():assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h,f
hashes();suites=['src/screens/generating-transaction/GeneratingTransaction.test.tsx','src/app/templates/history/HistoryDetails.test.tsx','src/app/templates/history/SwapDetail.test.tsx'];results=[]
def run(name,pattern=None):
 out=e/(name+'.json');cmd=['yarn','jest','--runTestsByPath',*suites,'--maxWorkers=2','--json','--outputFile='+str(out)]
 if pattern:cmd+=['--testNamePattern',pattern]
 with (e/(name+'.log')).open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
 x=json.loads(out.read_text());bad=[a for t in x['testResults'] for a in t['assertionResults'] if a['status']=='failed'];assert x['numRuntimeErrorTestSuites']==0
 if pattern:assert r.returncode!=0 and len(bad)>0 and all('expect(' in '\n'.join(a['failureMessages']) and 'TypeError' not in '\n'.join(a['failureMessages']) for a in bad)
 else:assert r.returncode==0 and x['numPassedTests']>0 and x['numTotalTestSuites']==3
 results.append({'name':name,'passed':x['numPassedTests'],'failed':len(bad),'runtime':x['numRuntimeErrorTestSuites']});print(json.dumps(results[-1]),flush=True)
run('baseline');path=pathlib.Path('src/screens/generating-transaction/GeneratingTransaction.tsx');original=path.read_text();pattern='reports the reason attached to the displayed status retry refusal|does not report retry evidence from a previous transaction after switching rows|reports a user-triggered raw retry failure on a persisted failed row'
mutations=[('forward','undefined, retryErrorDiagnostics','undefined, undefined'),('reason',"pendingRetryReason: snapshotPendingRetry(error) ?? 'unexpected'","pendingRetryReason: 'unexpected'"),('row-binding','retryError && retryError.transactionId === active?.id ? retryError.id : null','retryError?.id ?? null')]
for name,old,new in mutations:
 assert old in original
 try:path.write_text(original.replace(old,new,1));run(name,pattern)
 finally:path.write_text(original)
 hashes()
run('closing');hashes();assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip();(e/'summary.json').write_text(json.dumps({'source':m['source'],'tree':m['tree'],'results':results,'exact_restoration':True},indent=2)+'\n')
