import hashlib,json,os,pathlib,re,subprocess,tempfile
p=pathlib.Path(__file__).parent
e=pathlib.Path(os.environ['RUNNER_TEMP'])/'q6-f4-evidence'
m=json.loads((p/'source.json').read_text()); records=[]
def tree():
 with tempfile.TemporaryDirectory() as td:
  env=dict(os.environ,GIT_INDEX_FILE=td+'/index')
  subprocess.run(['git','read-tree','HEAD'],env=env,check=True)
  subprocess.run(['git','add','-u'],env=env,check=True)
  return subprocess.check_output(['git','write-tree'],env=env,text=True).strip()
def run(label,expected_tree,red):
 assert tree()==expected_tree
 assert subprocess.check_output(['git','hash-object','src/lib/settings/helpers.capacitor-mirror.test.ts'],text=True).strip()==m['test_blob']
 out=e/(label+'.json'); log=e/(label+'.log')
 cmd=['yarn','jest','--runTestsByPath','src/lib/settings/helpers.capacitor-mirror.test.ts','--maxWorkers=2','--json','--outputFile='+str(out)]
 with log.open('w') as f: c=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT)
 r=json.loads(out.read_text()); assert r['numTotalTests']==1 and r['numRuntimeErrorTestSuites']==0
 failed=[a for suite in r['testResults'] for a in suite['assertionResults'] if a['status']=='failed']
 if red:
  assert c.returncode!=0 and r['numFailedTests']==1 and r['numPassedTests']==0
  text=re.sub(r'\x1b\[[0-9;]*m','','\n'.join(x for a in failed for x in a['failureMessages']))
  assert re.search(r'Expected:\s*false',text) and re.search(r'Received:\s*true',text)
  assert 'ReferenceError' not in text and 'TypeError' not in text
 else: assert c.returncode==0 and r['numPassedTests']==1 and r['numFailedTests']==0
 records.append({'label':label,'source_tree':expected_tree,'exit':c.returncode,'passed':r['numPassedTests'],'failed':r['numFailedTests'],'runtime':r['numRuntimeErrorTestSuites'],'valid':True,'failures':failed,'command':cmd})
 (e/'runs.json').write_text(json.dumps(records,indent=2)+'\n')
 print(log.read_text(),flush=True)
assert hashlib.sha256((p/'counterfactual.patch').read_bytes()).hexdigest()==m['counterfactual_sha256']
run('current-red',m['source_tree'],True)
original=pathlib.Path('src/lib/settings/helpers.ts').read_bytes()
try:
 subprocess.run(['git','apply','--unidiff-zero',str(p/'counterfactual.patch')],check=True)
 run('old-mirror-green',m['old_tree'],False)
finally:
 pathlib.Path('src/lib/settings/helpers.ts').write_bytes(original)
assert tree()==m['source_tree']
(e/'restore.json').write_text(json.dumps({'restored':True,'source_tree':tree()}))
