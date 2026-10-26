import json,pathlib,subprocess,hashlib,sys
source=pathlib.Path('src/lib/miden/storage-health.ts')
original=source.read_text()
root=pathlib.Path('proof/mutations');root.mkdir(parents=True,exist_ok=True)
cases=[
 ('no-diagnostic-mirror','if (persist && !isInOffscreenDocument()) {','if (false && persist && !isInOffscreenDocument()) {','latches contextual backing-store failure'),
 ('poison-cancellation',"const excluded = typeof name === 'string' && /abort|cancel|deadline|timeout|poison|network/i.test(name);","const excluded = false && typeof name === 'string' && /abort|cancel|deadline|timeout|poison|network/i.test(name);",'does not poison health for ordinary'),
 ('generic-sdk-io',"((context.backend === 'wallet' || name === 'UnknownError') && /(?:I\\/O|IO) error/i.test(message))", "(true && /(?:I\\/O|IO) error/i.test(message))",'requires storage context for generic I/O'),
 ('ignore-error-cause',"pending.push(field(current, 'cause'), field(current, 'inner'));",'pending.push();','requires storage context for generic I/O'),
 ('forward-raw-diagnostic','return { status, epoch, reason, backend, operation, time };','return { ...value, status, epoch, reason, backend, operation, time };','propagates only sanitized unavailable snapshots'),
 ('skip-unavailable-gate',"if (snapshot.status !== 'healthy' || (expectedEpoch !== undefined && snapshot.epoch !== expectedEpoch))",'if (false)','hydrates an unavailable incident before allowing realm mutation starts'),
 ('forget-failure-revision','failureRevision++;','void failureRevision;','does not resume after a repeated failure caught during validation'),
 ('accept-forged-permit','recoveryCapabilities.get(capability) !== failureRevision ||','false ||','revokes a bounded recovery capability when validation ends and rejects forged capabilities'),
 ('claim-raced-validation-success','if (snapshot.epoch !== epoch || failureRevision !== revision) return false;','if (snapshot.epoch !== epoch || failureRevision !== revision) return true;','ignores stale healthy snapshots and refuses a validation raced by a new incident'),
 ('replace-first-failure',"if (snapshot.status === 'unavailable') return;",'if (false) return;','latches contextual backing-store failure')
]
results=[]
try:
 for label,old,new,prediction in cases:
  count=original.count(old)
  if count<1:raise RuntimeError('Mutation target missing: '+label)
  changed=original.replace(old,new)
  source.write_text(changed)
  folder=root/label;folder.mkdir(exist_ok=True)
  output=folder/'results.json'
  args=['yarn','jest','--runInBand','--runTestsByPath','src/lib/miden/storage-health.test.ts','--testNamePattern='+prediction,'--json','--outputFile='+str(output)]
  with (folder/'jest.log').open('w') as log:run=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
  report=json.loads(output.read_text())
  failed=[a for suite in report['testResults'] for a in suite['assertionResults'] if a['status']=='failed']
  executed=report['numPassedTests']+report['numFailedTests']
  killed=run.returncode!=0 and executed>0 and report['numRuntimeErrorTestSuites']==0 and any(prediction in a['fullName'] and any('expect(' in message for message in a['failureMessages']) for a in failed)
  receipt={'mutation':label,'prediction':prediction,'replacements':count,'original_sha256':hashlib.sha256(original.encode()).hexdigest(),'mutant_sha256':hashlib.sha256(changed.encode()).hexdigest(),'executed':executed,'failed':report['numFailedTests'],'runtime_errors':report['numRuntimeErrorTestSuites'],'killed':killed,'failed_titles':[a['fullName'] for a in failed]}
  results.append(receipt);print(json.dumps(receipt),flush=True)
  source.write_text(original)
  if not killed:raise RuntimeError('Mutation survived or failed outside intended assertion: '+label)
finally:
 source.write_text(original)
 (root/'receipts.json').write_text(json.dumps(results,indent=2)+'\n')
if len(results)!=len(cases):raise RuntimeError('Incomplete mutation set')
print('All '+str(len(results))+' mutations failed at predicted functional assertions',flush=True)
