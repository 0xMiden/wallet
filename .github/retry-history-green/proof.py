import hashlib,json,os,pathlib,subprocess
p=pathlib.Path(__file__).parent;m=json.loads((p/'source.json').read_text());e=pathlib.Path(os.environ['RUNNER_TEMP'])/'retry-history-green-evidence'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==m['source']
assert subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()==m['tree']
def hashes():
 for f,h in m['sha256'].items(): assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h,f
hashes();suites=['src/app/templates/history/HistoryDetails.test.tsx','src/app/templates/history/SwapDetail.test.tsx'];results=[]
def run(name,pattern=None):
 out=e/(name+'.json');cmd=['yarn','jest','--runTestsByPath',*suites,'--maxWorkers=2','--json','--outputFile='+str(out)]
 if pattern: cmd+=['--testNamePattern',pattern]
 with (e/(name+'.log')).open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
 x=json.loads(out.read_text());failed=[a for t in x['testResults'] for a in t['assertionResults'] if a['status']=='failed'];msg='\n'.join(v for a in failed for v in a['failureMessages']);print(name, 'exit',r.returncode,'pass',x['numPassedTests'],'fail',len(failed),'runtime',x['numRuntimeErrorTestSuites'],flush=True)
 assert x['numRuntimeErrorTestSuites']==0
 if pattern: assert r.returncode!=0 and len(failed)>0 and all('toHaveBeenCalledWith' in '\n'.join(a['failureMessages']) for a in failed) and 'TypeError' not in msg and 'ReferenceError' not in msg
 else: assert r.returncode==0 and x['numPassedTests']>0 and x['numTotalTestSuites']==2
 results.append({'name':name,'passed':x['numPassedTests'],'failed':len(failed),'runtime':x['numRuntimeErrorTestSuites']})
run('baseline')
mutations=[('inline-forward','src/app/templates/history/HistoryDetails.tsx','diagnostics={actions.retryErrorDiagnostics}','diagnostics={undefined}'),('payback-forward','src/app/templates/history/SwapDetail.tsx','errorDiagnostics={paybackRetryErrorDiagnostics}','errorDiagnostics={undefined}'),('reason','src/app/templates/history/useTransactionActions.ts',"pendingRetryReason: snapshotPendingRetry(error) ?? 'unexpected'","pendingRetryReason: 'unexpected'"),('earn-origin','src/app/templates/history/useTransactionActions.ts',"entry.txType === 'earn-withdraw' ? 'history_earn_receive' : 'history_primary'","'history_primary'")]
pattern='reports the payout retry reason|reports the Earn receive retry origin|reports the primary retry reason|reports a live retry failure with a closed producer identity'
for name,f,old,new in mutations:
 path=pathlib.Path(f);original=path.read_text();assert old in original
 try:
  path.write_text(original.replace(old,new,1));run(name,pattern)
 finally:path.write_text(original)
 hashes()
run('closing');hashes();assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip();(e/'summary.json').write_text(json.dumps({'source':m['source'],'tree':m['tree'],'results':results,'exact_restoration':True},indent=2)+'\n')
