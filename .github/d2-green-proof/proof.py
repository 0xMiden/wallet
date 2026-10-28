import hashlib,json,os,pathlib,subprocess,tempfile
p=pathlib.Path(__file__).parent;m=json.loads((p/'source.json').read_text());e=pathlib.Path(os.environ['RUNNER_TEMP'])/'d2-green-evidence';records=[]
assert hashlib.sha256((p/'mutations.json').read_bytes()).hexdigest()==m['mutation_sha256']
def tree():
 with tempfile.TemporaryDirectory() as td:
  env=dict(os.environ,GIT_INDEX_FILE=td+'/index');subprocess.run(['git','read-tree','HEAD'],env=env,check=True);subprocess.run(['git','add','-u'],env=env,check=True);return subprocess.check_output(['git','write-tree'],env=env,text=True).strip()
def run(label,suites,red=False):
 out=e/(label+'.json');log=e/(label+'.log');cmd=['yarn','jest','--runTestsByPath',*suites,'--maxWorkers=2','--json','--outputFile='+str(out)]
 with log.open('w') as f:r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT)
 x=json.loads(out.read_text());failed=[a for t in x['testResults'] for a in t['assertionResults'] if a['status']=='failed'];messages='\n'.join(v for a in failed for v in a['failureMessages'])
 record={'label':label,'command':cmd,'exit':r.returncode,'total':x['numTotalTests'],'passed':x['numPassedTests'],'failed':x['numFailedTests'],'runtime':x['numRuntimeErrorTestSuites'],'failed_names':[a['fullName'] for a in failed]};records.append(record);(e/'runs.json').write_text(json.dumps(records,indent=2)+'\n')
 print(log.read_text(),flush=True)
 assert len(x['testResults'])==len(suites) and x['numTotalTests']>0 and x['numRuntimeErrorTestSuites']==0
 if red:assert r.returncode!=0 and len(failed)>0 and 'ReferenceError' not in messages and 'TypeError' not in messages and all('expect(' in v for a in failed for v in a['failureMessages'])
 else:assert r.returncode==0 and x['numFailedTests']==0 and x['numPassedTests']==x['numTotalTests']
 record['valid']=True;(e/'runs.json').write_text(json.dumps(records,indent=2)+'\n')
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==m['source'] and tree()==m['tree']
for f,h in m['sha256'].items():assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h
run('baseline',m['baseline_suites'])
restores=[]
for mutation in json.loads((p/'mutations.json').read_text()):
 assert tree()==m['tree'];f=pathlib.Path(mutation['path']);original=f.read_bytes();text=original.decode();assert text.count(mutation['old'])==1
 try:
  f.write_text(text.replace(mutation['old'],mutation['new'],1));run(mutation['id'],m['regression_suites'],True)
 finally:f.write_bytes(original)
 assert tree()==m['tree'];restores.append({'id':mutation['id'],'exact_tree_restored':True,'prediction':mutation['prediction']});(e/'restores.json').write_text(json.dumps(restores,indent=2)+'\n')
run('closing',m['baseline_suites']);assert tree()==m['tree'];(e/'summary.json').write_text(json.dumps({'verified':True,'source':m['source'],'tree':m['tree'],'functional_mutations':len(restores),'exact_restoration':True},indent=2)+'\n')
