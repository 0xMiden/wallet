import hashlib,json,os,pathlib,subprocess,sys
root=pathlib.Path.cwd(); packet=root/'.github/diagnostic-proof';m=json.loads((packet/'manifest.json').read_text());proof=root/'proof';proof.mkdir(exist_ok=True);tmp=pathlib.Path(os.environ['RUNNER_TEMP'])/'diagnostic-proof';tmp.mkdir(exist_ok=True)
results=[]
def command(name,args,expected_failure=False):
 log=tmp/(name+'.log');jp=tmp/(name+'.json')
 with log.open('w') as f:r=subprocess.run(args,stdout=f,stderr=subprocess.STDOUT)
 record={'name':name,'exit':r.returncode}
 if jp.exists():
  d=json.loads(jp.read_text());record.update(passed=d['numPassedTests'],failed=d['numFailedTests'],executed=d['numPassedTests']+d['numFailedTests'],runtime=d['numRuntimeErrorTestSuites'],failed_names=[a['fullName'] for s in d['testResults'] for a in s['assertionResults'] if a['status']=='failed'])
  valid=record['executed']>0 and record['runtime']==0 and ((r.returncode!=0 and record['failed']>0) if expected_failure else (r.returncode==0 and record['failed']==0))
 else:valid=r.returncode==0 and not expected_failure
 results.append(record);print(json.dumps(record),flush=True);(proof/'results.json').write_text(json.dumps(results,indent=2))
 if not valid:
  if not expected_failure: print(log.read_text()[-12000:],flush=True)
  raise SystemExit('Check did not meet its declared role: '+name)
def jest(name,files,pattern=None,red=False):
 args=['yarn','jest','--runTestsByPath',*files,'--maxWorkers=2','--json','--outputFile='+str(tmp/(name+'.json'))]
 if pattern:args.extend(['--testNamePattern',pattern])
 command(name,args,red)
assert subprocess.check_output(['git','rev-parse','HEAD^'],text=True).strip()==m['source_sha']
command('types',['yarn','tsc','--noEmit'])
command('lint',['yarn','eslint','--max-warnings=0',*m['lint_files']])
jest('green',m['test_files'])
for name,rel,old,new,test,pattern,count in m['cases']:
 p=root/rel;before=p.read_bytes();s=before.decode();assert s.count(old)==count,(name,'replacement count')
 try:
  p.write_text(s.replace(old,new));jest(name,[test],pattern,True)
 finally:
  p.write_bytes(before);assert p.read_bytes()==before
 record={'restored':rel,'sha256':hashlib.sha256(before).hexdigest()};(proof/(name+'-restoration.json')).write_text(json.dumps(record))
assert subprocess.check_output(['git','diff','--name-only'],text=True).strip()==''
print('All intended mutations failed functionally; exact source bytes restored.',flush=True)
