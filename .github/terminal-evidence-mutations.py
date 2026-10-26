import json,re,subprocess
from pathlib import Path
cases=[
 ('prefix','src/lib/miden/sdk/proposal-create-error-family.ts','message.startsWith(prefix)','message.includes(prefix)','src/lib/miden/sdk/proposal-create-error-family.test.ts','requires exact leading context'),
 ('typed-pair','src/lib/miden/sdk/proposal-create-error-family.ts','name === expectedName && code === expectedCode','name === expectedName','src/lib/miden/sdk/proposal-create-error-family.test.ts','requires the exact typed pair'),
 ('observer','src/lib/telemetry/crash-diagnostics.ts','onReject?.(error);','void onReject;','src/lib/miden/guardian/proposal-diagnostics.test.ts','actual consume rejection family'),
 ('fallback','src/lib/miden/transaction/index.ts',"observe(fallbackError, 'prove_fallback')","observe(fallbackError, 'prove_delegate')",'src/lib/miden/transaction/transactions.guardian.test.ts','prover outage the local fallback cannot rescue'),
 ('unexamined','src/lib/miden/transaction/index.ts','pruneQueueAdmission(examined);','pruneQueueAdmission(queuedTransactions);','src/lib/miden/transaction/transactions.guardian.test.ts','directly examined admission decisions'),
 ('collateral','src/lib/miden/back/miden-client-proxy.ts',"op_id === killerId && deadline.killer === 'write' && op.started", "deadline.killer === 'write' && op.started",'src/lib/miden/back/miden-client-proxy.test.ts','binds the last accepted stage'),
 ('commit-binding','src/lib/miden/transaction/cancel.ts','matchesReapSelection(committed, reapSelection)','true','src/lib/miden/transaction/cancel.test.ts','changed committed'),
 ('egress','src/lib/telemetry/transaction-failure.ts','transferProposalCreateDiagnostics(failure.error, report);','void failure.error;','src/lib/miden/transaction/proposal-diagnostics.integration.test.ts','only the observed consume family through final serialization'),
 ('cutoff','src/lib/telemetry/reap-start-diagnostics.ts','processingStartedAt < realmCutoff','processingStartedAt <= realmCutoff','src/lib/telemetry/reap-start-diagnostics.test.ts','classifies'),
 ('freshness','src/lib/miden/transaction/queue-admission-diagnostics.ts','age <= 60000','age <= 60001','src/lib/miden/transaction/queue-admission-diagnostics.test.ts','rejects invalid age'),
 ('reuse','src/lib/telemetry/crash-diagnostics.ts','clearProposalCreateDiagnostics(error);','void error;','src/lib/miden/guardian/proposal-diagnostics.test.ts','reused consume rejection observation'),
 ('cause','src/lib/telemetry/closed-root-diagnostics.ts','validate(observations.get(error))',"validate(observations.get(error) ?? observations.get(ownDiagnosticData(error, 'cause') as object))",'src/lib/telemetry/guardian-proving-diagnostics.test.ts','without following causes')
]
results=[]
for name,source,needle,replacement,test,pattern in cases:
 path=Path(source);original=path.read_text()
 if original.count(needle)!=1: raise RuntimeError(name+': mutation needle mismatch '+str(original.count(needle)))
 log=Path('mutation-'+name+'.log');resultPath=Path('mutation-'+name+'.json')
 try:
  path.write_text(original.replace(needle,replacement,1))
  with log.open('w') as output:
   run=subprocess.run(['yarn','test','--runTestsByPath',test,'--testNamePattern',pattern,'--maxWorkers=2','--ci','--json','--outputFile',str(resultPath)],stdout=output,stderr=subprocess.STDOUT)
  value=json.loads(resultPath.read_text())
  failed=[a for suite in value['testResults'] for a in suite.get('assertionResults',[]) if a['status']=='failed']
  if run.returncode==0 or value['numFailedTests']<1 or not failed or not any('expect(' in message or 'Expected' in message for a in failed for message in a.get('failureMessages',[])):
   raise RuntimeError(name+': no functional assertion killed mutation; inspect '+str(log))
  results.append({'mutation':name,'failed':value['numFailedTests'],'passed':value['numPassedTests'],'executed':value['numPassedTests']+value['numFailedTests']})
  print(json.dumps(results[-1]),flush=True)
 finally:
  path.write_text(original)
  assert path.read_text()==original
Path('terminal-mutations.json').write_text(json.dumps(results,indent=2)+'\n')
