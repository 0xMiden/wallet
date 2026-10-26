import json,subprocess
from pathlib import Path
producer='src/lib/miden/transaction/reconcile-unconfirmed.ts'
reporter='src/lib/telemetry/transaction-failure.ts'
store='src/lib/telemetry/proof-wait-availability-diagnostics.ts'
integration='src/lib/miden/transaction/proof-wait-availability.integration.test.ts'
unit='src/lib/telemetry/proof-wait-availability.report.test.ts'
pure='src/lib/telemetry/proof-wait-availability-diagnostics.test.ts'
cases=[
 ('precedence',producer,'timingAvailability ?? windowAvailability','windowAvailability ?? timingAvailability',integration,'current calculation availability'),
 ('current-entry',producer,'entry.attemptId === failedAttemptId','true',integration,'current calculation availability'),
 ('eager-read',producer,'if (expiredEntry?.refBlock === undefined)',"if ((expiredEntry?.expirationBlock, expiredEntry?.refBlock) === undefined)",integration,'preserves original short circuit'),
 ('execution-finite',producer,'!Number.isFinite(executing)','false',integration,'availability execution_time_invalid'),
 ('submit-finite',producer,'!Number.isFinite(submitting)','false',integration,'availability submit_time_invalid'),
 ('wait-overflow',producer,'!Number.isFinite(proofWaitBlocks) || proofWaitBlocks < 0','proofWaitBlocks < 0',integration,'availability derived_wait_invalid'),
 ('window-overflow',producer,'!Number.isFinite(expiryWindowBlocks) || expiryWindowBlocks <= 0','expiryWindowBlocks <= 0',integration,'availability derived_window_invalid'),
 ('shared-constant',producer,'annotateProofWaitAvailability(failure, availability)','annotateProofWaitAvailability(TRANSACTION_NEVER_COMMITTED_ERROR, availability)',integration,'binds producer availability'),
 ('structural',store,'export const snapshotProofWaitAvailability = store.snapshot;',"export const snapshotProofWaitAvailability = (target: unknown) => store.snapshot(target) ?? validateProofWaitAvailability((target as { proofWaitAvailability?: unknown })?.proofWaitAvailability);",pure,'without structural or cause promotion'),
 ('cause',store,'export const snapshotProofWaitAvailability = store.snapshot;',"export const snapshotProofWaitAvailability = (target: unknown) => store.snapshot(target) ?? store.snapshot((target as { cause?: unknown })?.cause);",pure,'without structural or cause promotion'),
 ('invalid-clearing','src/lib/telemetry/closed-root-diagnostics.ts','if (safe === undefined) observations.delete(error);','if (safe === undefined) return;',pure,'clears a reused root'),
 ('point-gate',reporter,"point === 'node_verdict' && reason === 'never_committed' && reportedNeverCommittedRule === 'expired'","reason === 'never_committed' && reportedNeverCommittedRule === 'expired'",unit,'effective scope override'),
 ('rule-gate',reporter,"point === 'node_verdict' && reason === 'never_committed' && reportedNeverCommittedRule === 'expired'","point === 'node_verdict' && reason === 'never_committed'",unit,'effective scope override'),
 ('reason-composite-gate',reporter,"point === 'node_verdict' && reason === 'never_committed' && reportedNeverCommittedRule === 'expired'","point === 'node_verdict'",unit,'effective scope override'),
 ('report-transfer',reporter,'annotateProofWaitAvailability(report, snapshotProofWaitAvailability(failure));','void failure;',integration,'current calculation availability'),
 ('raw-final-spread','src/lib/telemetry/crash.ts','event.extra = { walletDiagnostics: { ...diagnostics } };',"event.extra = { walletDiagnostics: { ...diagnostics, ...(event.extra as { walletDiagnostics?: object })?.walletDiagnostics } };",integration,'serialized capture'),
 ('arithmetic',producer,'Math.floor((submitting - executing) / ESTIMATED_MS_PER_BLOCK)','Math.floor((submitting - executing) / (ESTIMATED_MS_PER_BLOCK * 2))','src/lib/miden/transaction/reconcile-unconfirmed.writes.test.ts','definitive verdict once')
]
results=[]
for name,source,needle,replacement,test,pattern in cases:
 path=Path(source);original=path.read_text()
 if original.count(needle)!=1: raise RuntimeError(name+': mutation needle mismatch '+str(original.count(needle)))
 resultPath=Path('mutation-'+name+'.json')
 try:
  path.write_text(original.replace(needle,replacement,1))
  with Path('mutation-'+name+'.log').open('w') as output:
   run=subprocess.run(['yarn','test','--runTestsByPath',test,'--testNamePattern',pattern,'--maxWorkers=2','--ci','--json','--outputFile',str(resultPath)],stdout=output,stderr=subprocess.STDOUT)
  value=json.loads(resultPath.read_text())
  failed=[a for suite in value['testResults'] for a in suite.get('assertionResults',[]) if a['status']=='failed']
  if run.returncode==0 or not failed or not any('expect(' in message or 'Expected' in message for a in failed for message in a.get('failureMessages',[])):
   raise RuntimeError(name+': no functional assertion killed mutation')
  results.append({'mutation':name,'failed':value['numFailedTests'],'passed':value['numPassedTests'],'executed':value['numPassedTests']+value['numFailedTests']})
  Path('proof-wait-mutations.json').write_text(json.dumps(results,indent=2)+'\n')
  print(json.dumps(results[-1]),flush=True)
 finally:
  path.write_text(original)
  assert path.read_text()==original
