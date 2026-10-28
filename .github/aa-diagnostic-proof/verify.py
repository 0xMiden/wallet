import hashlib,json,os,pathlib,subprocess
root=pathlib.Path.cwd();p=root/'.github/aa-diagnostic-proof';m=json.loads((p/'manifest.json').read_text());out=root/'proof';out.mkdir(exist_ok=True);raw=pathlib.Path(os.environ['RUNNER_TEMP'])/'aa-diagnostic-raw';raw.mkdir(exist_ok=True);results=[]
def command(name,args,role):
 log=raw/(name+'.log');jp=raw/(name+'.json')
 with log.open('w') as f:r=subprocess.run(args,stdout=f,stderr=subprocess.STDOUT)
 row={'name':name,'role':role,'exit':r.returncode}
 if jp.exists():
  d=json.loads(jp.read_text());row.update(passed=d['numPassedTests'],failed=d['numFailedTests'],executed=d['numPassedTests']+d['numFailedTests'],runtime=d['numRuntimeErrorTestSuites'],failed_names=[a['fullName'] for s in d['testResults'] for a in s['assertionResults'] if a['status']=='failed'])
  valid=row['executed']>0 and row['runtime']==0 and ((r.returncode!=0 and row['failed']>0) if role=='expected_functional_failure' else (r.returncode==0 and row['failed']==0))
 else:valid=r.returncode==0 and role=='green'
 results.append(row);(out/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps(row),flush=True)
 if not valid:
  if name in ['types','lint']:print(log.read_text()[-14000:],flush=True)
  raise RuntimeError('Verification role failed: '+name)
def jest(name,files,pattern=None,role='green'):
 args=['yarn','jest','--runTestsByPath',*files,'--maxWorkers=2','--json','--outputFile='+str(raw/(name+'.json'))]
 if pattern:args+=['--testNamePattern',pattern]
 command(name,args,role)
for rel,sha in m['source_file_sha256'].items():assert hashlib.sha256((root/rel).read_bytes()).hexdigest()==sha
command('types',['yarn','tsc','--noEmit'],'green')
command('lint',['yarn','eslint','--max-warnings=0',*m['lint_files']],'green')
jest('baseline',m['test_files'])
restored=[]
for case in m['cases']:
 name=case['name'];path=root/case['path'];before=path.read_bytes();source=before.decode();assert source.count(case['old'])==case['replacement_count'],(name,'replacement count')
 try:
  path.write_text(source.replace(case['old'],case['new']));jest(name,case['test_files'],case['test_name_pattern'],'expected_functional_failure')
 finally:
  path.write_bytes(before);assert path.read_bytes()==before
  restored.append({'name':name,'path':case['path'],'sha256':hashlib.sha256(before).hexdigest(),'restored':True});(out/'restorations.json').write_text(json.dumps(restored,indent=2))
for rel,sha in m['source_file_sha256'].items():assert hashlib.sha256((root/rel).read_bytes()).hexdigest()==sha
assert subprocess.check_output(['git','diff','--name-only'],text=True).strip()==''
print('All12 mutations failed functionally with nonzero execution and runtime0; source restored exactly.',flush=True)
