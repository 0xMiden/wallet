#!/usr/bin/env python3
"""CI-only genuine wallet worker matrix orchestration; product and fixture remain frozen."""
import argparse, base64, hashlib, json, os, re, subprocess, time
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('stage',choices=['bind','snapshot','browser-install','build-st','run','verify','preserve'])
args=parser.parse_args()
if os.environ.get('GITHUB_ACTIONS')!='true': raise SystemExit('CI-only disposable proof')
root=Path(os.environ['GITHUB_WORKSPACE']).resolve();proof=root/'proof';proof.mkdir(exist_ok=True)
wallet=root/'wallet';replay=root/'replay';build=root/'retained-builds'
cfg=json.loads((root/'controller/.github/ci/issue1948-retained-vault-native/inputs.json').read_text())
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1048576),b''):h.update(block)
    return h.hexdigest()
def save(name,value):(proof/name).write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')
def read(name):return json.loads((proof/name).read_text())
def hashes(directory):return {p.relative_to(directory).as_posix():sha(p) for p in sorted(directory.rglob('*')) if p.is_file()}
def source_files(directory):
    for name,expected in {**cfg['fixture_files'],**cfg['product_closures']}.items():
        if sha(directory/name)!=expected:raise RuntimeError('Frozen source closure changed: '+name)
def preserve():
    source_files(wallet)
    if {p:sha(wallet/p) for p in ['package.json','yarn.lock']}!={p:sha(proof/('effective-'+p)) for p in ['package.json','yarn.lock']}:
        raise RuntimeError('Injected wallet effective package/lock changed')
    if replay.exists():
        source_files(replay)
        effective=read('effective-lock.json')
        if sha(replay/'package.json')!=effective['package_sha256'] or sha(replay/'yarn.lock')!=effective['lock_sha256']:raise RuntimeError('Fresh replay effective lock changed')
        packages=read('packages.json')
        for package in packages:
            directory=replay/'node_modules'/package['name']
            for name,expected in package['payload_sha256'].items():
                if sha(directory/name)!=expected:raise RuntimeError('Installed exact package payload changed')
        copies=[]
        for directory,children,names in os.walk(replay/'node_modules',followlinks=False):
            if Path(directory).name=='miden-sdk' and Path(directory).parent.name=='@miden-sdk' and 'package.json' in names:copies.append(str(Path(directory).resolve().relative_to(replay)))
        if copies!=['node_modules/@miden-sdk/miden-sdk']:raise RuntimeError('One physical SDK closure changed')
        actual=hashes(replay/'node_modules/@miden-sdk/miden-sdk/dist')
        if actual!=cfg['dist_sha256'] or len(actual)!=42:raise RuntimeError('Original42 installed dist hashes changed')
        save('installed-dist-after.json',actual)
    if (proof/'emitted-before.json').is_file() and hashes(build)!=read('emitted-before.json'):raise RuntimeError('Emitted browser assets changed after build')
    save('retained-preserved.json',{'fixture_files':cfg['fixture_files'],'product_closures':cfg['product_closures'],'dist_files':42,'effective_lock_unchanged':True,'all_three_payloads_unchanged':True,'one_sdk_directory':True})
def command(argv,log,timeout):
    with (proof/log).open('wb') as out:subprocess.run(argv,cwd=replay,stdout=out,stderr=subprocess.STDOUT,check=True,timeout=timeout)
def remaining(limit):
    start=read('functional-start.json')['unix_seconds'];left=900-(time.time()-start)
    if left<=0:raise RuntimeError('Functional15minute bound exhausted')
    return min(limit,left)
try:
    if args.stage=='bind':
        source_files(wallet)
        original={p:sha(wallet/p) for p in ['package.json','yarn.lock']}
        if original!=cfg['original_package_lock']:raise RuntimeError('Original immutable package/lock mismatch')
        declared=json.loads((wallet/'playwright/proofs/storage-retained-vault-native/inputs.json').read_text())
        if declared['dist_sha256']!=cfg['dist_sha256'] or declared['case_ids']!=cfg['expected_case_titles']:raise RuntimeError('Frozen fixture input identity mismatch')
        save('retained-source.json',{'source':cfg['wallet_source'],'tree':cfg['wallet_tree'],'fixture_files':cfg['fixture_files'],'product_closures':cfg['product_closures'],'original_package_lock':original})
    elif args.stage=='snapshot':
        preserve()
        if build.exists():raise RuntimeError('Fresh disposable build root required')
        if read('frozen-replay.json')['fresh_dependency_tree'] is not True:raise RuntimeError('Fresh frozen replay required')
        changes=read('approved-target-transitive-lock-changes.json')
        if {x['header'] for x in changes}!=set(cfg['approved_target_lock_changes']) or len(changes)!=4:raise RuntimeError('Require exact4 approved optional Node removals')
        save('installed-dist-before.json',hashes(replay/'node_modules/@miden-sdk/miden-sdk/dist'))
    elif args.stage=='browser-install':
        command(['yarn','playwright','install','--with-deps','chromium'],'chromium-install.log',240)
        preserve()
    elif args.stage=='build-st':
        if args.stage=='build-st':save('functional-start.json',{'unix_seconds':time.time(),'functional_seconds':900})
        preserve()
        os.environ['WALLET_MATRIX_MODE']=args.stage.split('-')[1]
        command(['yarn','vite','build','--config','playwright/proofs/storage-retained-vault-native/vite.config.mts'],args.stage+'.log',remaining(240))
        for variant in (['st'] if args.stage=='build-st' else ['st','mt']):
            directory=build/variant
            files=hashes(directory)
            if not (directory/'index.html').is_file() or not (directory/'.vite/manifest.json').is_file():raise RuntimeError('Expected Vite manifest/index missing')
            if not any(p.endswith('.js') for p in files) or not any(p.endswith('.wasm') for p in files):raise RuntimeError('Expected emitted JS/WASM closure missing')
            save('emitted-'+variant+'.json',{'variant':variant,'files':files,'vite_manifest':json.loads((directory/'.vite/manifest.json').read_text()),'emitted_not_original_dist':True})
        save('emitted-before.json',hashes(build))
        preserve()
    elif args.stage=='run':
        preserve()
        command(['yarn','playwright','test','--config','playwright/proofs/storage-retained-vault-native/playwright.config.mts','--retries=0','--workers=1'],'browser-tests.log',remaining(600))
    elif args.stage=='verify':
        preserve()
        data=read('results.json');cases=[]
        if data.get('errors'):raise RuntimeError('Browser runner error')
        if data['config']['workers']!=1 or len(data['config']['projects'])!=1 or data['config']['projects'][0]['retries']!=0:raise RuntimeError('Bounded browser configuration')
        def walk(suite):
            for spec in suite.get('specs',[]):
                if not spec['file'].endswith('recovery.spec.mjs') or len(spec['tests'])!=1:raise RuntimeError('Unexpected test inventory')
                test=spec['tests'][0];results=test['results']
                if len(results)!=1 or results[0]['retry']!=0 or results[0]['status'] not in ['passed','failed','timedOut']:raise RuntimeError('Exactly one terminal attempt')
                attachments=results[0].get('attachments',[])
                selected=[a for a in attachments if a.get('name')=='closed-recovery-observations']
                if len(selected)!=1 or selected[0].get('contentType')!='application/json' or 'body' not in selected[0]:raise RuntimeError('Closed observation missing')
                receipt=json.loads(base64.b64decode(selected[0]['body'],validate=True))
                if set(receipt)!={'schema','includePrivate','stage','prepare','recover','outsideRequests','phase','service','workerEvents','storageEvents'} or receipt['schema']!=1 or type(receipt['includePrivate'])is not bool:raise RuntimeError('Closed result schema')
                for step in ['prepare','recover']:
                    value=receipt[step]
                    if value is not None and (set(value)!={'phase','checks'} or any(type(v)is not bool for v in value['checks'].values())):raise RuntimeError('Boolean-only checks')
                if type(receipt['outsideRequests'])is not int or any(type(v)is not int for v in receipt['service'].values()):raise RuntimeError('Count-only network observations')
                if set(receipt['workerEvents'])!={'started','closed','assetRequests','assetFailures','assetNotFound'} or any(type(v)is not int for v in receipt['workerEvents'].values()):raise RuntimeError('Count-only worker observations')
                if set(receipt['storageEvents'])!={'open','upgrade','blocked','success','error','txStart','txComplete','txAbort','txError','sdkTxStart','sdkTxComplete','otherTxStart','otherTxComplete','nativeMarker','nativeOpen','nativeDatabasesStart','nativeDatabasesEnd','nativeHeartbeat'} or any(type(v)is not int for v in receipt['storageEvents'].values()):raise RuntimeError('Count-only storage observations')
                cases.append({'title':spec['title'],'status':results[0]['status'],'retry':0,'duration_ms':results[0]['duration'],'receipt':receipt})
            for child in suite.get('suites',[]):walk(child)
        for suite in data['suites']:walk(suite)
        if sorted(c['title'] for c in cases)!=sorted(cfg['expected_case_titles']) or len(cases)!=1:raise RuntimeError('Exact authorized soft-wipe case required')
        passed=sum(c['status']=='passed' for c in cases)
        save('retained-observed-result.json',{'source':cfg['wallet_source'],'tree':cfg['wallet_tree'],'sdk_source':cfg['sdk_head'],'producer':cfg['compiled_producer'],'passed':passed,'failed':1-passed,'runtime_errors':0,'case_count':1,'workers':1,'retries':0,'cases':cases,'scope':'ST simulated desktop authorized soft setup wipe','sdk_owned_mutations':False,'whole_C3_acceptance':False})
        if passed!=1 or data['stats']['expected']!=1 or any(data['stats'][k]!=0 for k in ['unexpected','skipped','flaky']):raise RuntimeError('Require genuine authorized soft-wipe case')
        receipt=cases[0]['receipt'];checks=receipt['recover']['checks']
        required=['fixturePrivateAccount','fixtureAccountShape','priorJournalAndAttempt','priorGenerationBound','quotaInjected','simulatedDesktopSelected','lifecycleHealthHealthy','newAuthorizedGeneration','syntheticRowRemoved','journalRemovedByExplicitWipe','oldVaultCannotUnlock','staleVaultCannotRecreateJournal','noSubmission']
        if receipt['stage']!='complete' or receipt['outsideRequests']!=0 or receipt['service'].get('submitCalls')!=0 or any(checks.get(k)is not True for k in required):raise RuntimeError('Authorized soft-wipe contract')
        save('retained-verified-result.json',{'source':cfg['wallet_source'],'tree':cfg['wallet_tree'],'passed':1,'failed':0,'runtime_errors':0,'workers':1,'retries':0,'observed_result_sha256':sha(proof/'retained-observed-result.json'),'whole_C3_acceptance':False})
    elif args.stage=='preserve':preserve()
except BaseException as error:
    save('retained-'+args.stage+'-failure.json',{'stage':args.stage,'status':'failed','error_class':type(error).__name__,'exit':getattr(error,'returncode',None),'result_json_present':(proof/'results.json').is_file(),'retry':False})
    raise
finally:
    if args.stage not in ['bind'] and (proof/'installed-dist-before.json').is_file():preserve()
print('Completed retained Vault proof stage: '+args.stage)
