import hashlib,json,os,pathlib,subprocess
p=pathlib.Path(__file__).parent;m=json.loads((p/'source.json').read_text());e=pathlib.Path(os.environ['RUNNER_TEMP'])/'retry-identity-evidence';assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==m['source'] and subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()==m['tree']
def hashes():
 for f,h in m['sha256'].items():assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h
hashes();path=pathlib.Path('src/app/templates/history/useTransactionActions.ts');original=path.read_text();old='retryErrorId: retryErrorId?.transactionId === transactionId ? retryErrorId.id : null';new='retryErrorId: retryErrorId?.id ?? null';assert old in original
results=[]
def run(name,success):
 out=e/(name+'.json');cmd=['yarn','jest','--runTestsByPath','src/app/templates/history/HistoryDetails.test.tsx','--maxWorkers=2','--json','--outputFile='+str(out),'--testNamePattern','does not report a retry refusal that settles after switching transaction rows']
 with (e/(name+'.log')).open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
 x=json.loads(out.read_text());bad=[a for t in x['testResults'] for a in t['assertionResults'] if a['status']=='failed'];assert x['numRuntimeErrorTestSuites']==0
 if success:assert r.returncode==0 and x['numPassedTests']==1
 else:assert r.returncode!=0 and len(bad)==1 and 'not.toHaveBeenCalled' in '\n'.join(bad[0]['failureMessages'])
 results.append({'name':name,'passed':x['numPassedTests'],'failed':len(bad),'runtime':x['numRuntimeErrorTestSuites']})
run('baseline',True)
try:path.write_text(original.replace(old,new,1));run('remove-row-binding',False)
finally:path.write_text(original)
hashes();run('closing',True);hashes();assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip();(e/'summary.json').write_text(json.dumps({'source':m['source'],'tree':m['tree'],'results':results,'exact_restoration':True},indent=2)+'\n');print(json.dumps(results))
