#!/usr/bin/env python3
"""CI-only genuine wallet factory6 orchestration; product and fixture remain frozen."""
import argparse, base64, hashlib, json, os, re, subprocess, time
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('stage',choices=['bind','snapshot','browser-install','build-mock','build-normal','run','verify','preserve'])
args=parser.parse_args()
if os.environ.get('GITHUB_ACTIONS')!='true': raise SystemExit('CI-only disposable proof')
root=Path(os.environ['GITHUB_WORKSPACE']).resolve();proof=root/'proof';proof.mkdir(exist_ok=True)
wallet=root/'wallet';replay=root/'replay';build=root/'factory-builds'
cfg=json.loads((root/'controller/.github/ci/issue1948-wallet-factory6/inputs.json').read_text())
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
    save('factory-preserved.json',{'fixture_files':cfg['fixture_files'],'product_closures':cfg['product_closures'],'dist_files':42,'effective_lock_unchanged':True,'all_three_payloads_unchanged':True,'one_sdk_directory':True})
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
        declared=json.loads((wallet/'playwright/proofs/storage-wallet-factory/inputs.json').read_text())
        if declared['dist_sha256']!=cfg['dist_sha256'] or declared['case_ids']!=cfg['expected_case_titles']:raise RuntimeError('Frozen fixture input identity mismatch')
        save('factory-source.json',{'source':cfg['wallet_source'],'tree':cfg['wallet_tree'],'fixture_files':cfg['fixture_files'],'product_closures':cfg['product_closures'],'original_package_lock':original})
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
    elif args.stage in ['build-mock','build-normal']:
        if args.stage=='build-mock':save('functional-start.json',{'unix_seconds':time.time(),'functional_seconds':900})
        preserve()
        os.environ['WALLET_FACTORY_VARIANT']=args.stage.split('-')[1]
        command(['yarn','vite','build','--config','playwright/proofs/storage-wallet-factory/vite.config.mts'],args.stage+'.log',remaining(240))
        for variant in (['mock'] if args.stage=='build-mock' else ['mock','normal']):
            directory=build/variant
            files=hashes(directory)
            if not (directory/'index.html').is_file() or not (directory/'.vite/manifest.json').is_file():raise RuntimeError('Expected Vite manifest/index missing')
            if not any(p.endswith('.js') for p in files) or not any(p.endswith('.wasm') for p in files):raise RuntimeError('Expected emitted JS/WASM closure missing')
            save('emitted-'+variant+'.json',{'variant':variant,'files':files,'vite_manifest':json.loads((directory/'.vite/manifest.json').read_text()),'emitted_not_original_dist':True})
        if args.stage=='build-normal':save('emitted-before.json',hashes(build))
        preserve()
    elif args.stage=='run':
        preserve()
        command(['yarn','playwright','test','--config','playwright/proofs/storage-wallet-factory/playwright.config.ts','--project=chromium','--retries=0','--workers=2'],'browser-tests.log',remaining(840))
    elif args.stage=='verify':
        remaining(840);preserve();data=read('results.json')
        if data.get('errors') or data['stats']['expected']!=6 or any(data['stats'][k]!=0 for k in ['unexpected','skipped','flaky']):raise RuntimeError('Require6passed with no runner errors/failures/skips/flaky')
        if data['config']['workers']!=2 or len(data['config']['projects'])!=1 or data['config']['projects'][0]['retries']!=0:raise RuntimeError('Exact2workers/oneproject/retry0 required')
        cases=[]
        def walk(suite):
            for spec in suite.get('specs',[]):
                if not spec['file'].endswith('factory.spec.ts') or len(spec['tests'])!=1:raise RuntimeError('Unexpected test selection')
                case=spec['tests'][0];results=case['results']
                if case['status']!='expected' or len(results)!=1 or results[0]['status']!='passed' or results[0]['retry']!=0 or results[0].get('errors'):raise RuntimeError('Every title must pass once retry0')
                attachments=results[0].get('attachments',[])
                if len(attachments)!=1 or set(attachments[0])!={'name','contentType','body'} or attachments[0]['name']!='wallet-factory-receipt' or attachments[0]['contentType']!='application/json':raise RuntimeError('Exact safe attachment required')
                receipt=json.loads(base64.b64decode(attachments[0]['body'],validate=True))
                if set(receipt)!={'ok','phase','checks','observations','digests','variant','sdkBuild','nonLoopbackRequest','unexpectedRequest'}:raise RuntimeError('Closed safe receipt schema required')
                title=spec['title'];rule=cfg['receipt_schema'].get(title)
                if rule is None or receipt['ok'] is not True or receipt['phase']!='complete' or receipt['variant']!=rule['variant'] or receipt['sdkBuild']!='st' or receipt['nonLoopbackRequest'] is not False or receipt['unexpectedRequest'] is not False:raise RuntimeError('Factory case contract or network policy failed')
                if set(receipt['checks'])!=set(rule['checks']) or any(v is not True for v in receipt['checks'].values()):raise RuntimeError('Exact required functional checks must all be true')
                if set(receipt['observations'])!=set(rule['observations']):raise RuntimeError('Closed observation schema required')
                for key,kind in rule['observations'].items():
                    value=receipt['observations'][key]
                    if kind=='boolean' and type(value) is not bool:raise RuntimeError('Boolean observation required')
                    if kind=='positive-integer' and (type(value) is not int or value<1):raise RuntimeError('Positive transaction count required')
                if set(receipt['digests'])!=set(rule['digests']) or any(not isinstance(v,str) or not re.fullmatch('[0-9a-f]{64}',v) for v in receipt['digests'].values()):raise RuntimeError('Exact hash-only digest schema required')
                cases.append({'title':title,'status':'passed','retry':0,'receipt':receipt})
            for child in suite.get('suites',[]):walk(child)
        for suite in data['suites']:walk(suite)
        if sorted(c['title'] for c in cases)!=sorted(cfg['expected_case_titles']) or len(cases)!=6:raise RuntimeError('Exactly six distinct declared cases required')
        save('factory-verified-result.json',{'status':'six-actual-wallet-ST-prerequisites-only','source':cfg['wallet_source'],'tree':cfg['wallet_tree'],'sdk_source':cfg['sdk_head'],'passed':6,'failed':0,'skipped':0,'flaky':0,'retries':0,'workers':2,'cases':cases,'functional_seconds':time.time()-read('functional-start.json')['unix_seconds'],'normal_worker_coverage':False,'mt_coverage':False,'private_vault_recovery_coverage':False,'production_acceptance':False})
    elif args.stage=='preserve':preserve()
except BaseException as error:
    save('factory-'+args.stage+'-failure.json',{'stage':args.stage,'status':'failed','error_class':type(error).__name__,'exit':getattr(error,'returncode',None),'result_json_present':(proof/'results.json').is_file(),'retry':False})
    raise
finally:
    if args.stage not in ['bind'] and (proof/'installed-dist-before.json').is_file():preserve()
print('Completed factory stage: '+args.stage)
