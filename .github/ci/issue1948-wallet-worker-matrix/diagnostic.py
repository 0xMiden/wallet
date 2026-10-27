import json, os, re
from pathlib import Path
if os.environ.get('GITHUB_ACTIONS') != 'true': raise SystemExit('CI-only diagnostic')
root = Path(os.environ['GITHUB_WORKSPACE'])
proof = root / 'proof'
case = 'mt/classic/normal-create'
records = []
for line in (proof / 'browser-tests.log').read_text(errors='replace').splitlines():
    match = re.search(r'MATRIX_(PROGRESS|TERMINAL) (\{.*\})', line)
    if not match: continue
    value = json.loads(match[2])
    if value.get('caseId') != case: raise SystemExit('Unexpected diagnostic case')
    allowed = {'caseId', 'sequence', 'stage', 'elapsedMs'} if match[1] == 'PROGRESS' else {'caseId', 'latest', 'sequence', 'status', 'elapsedMs'}
    if value.get('stage') in {'asset-http-failure', 'asset-request-failed'}:
        allowed.add('asset')
        asset = value.get('asset')
        asset_keys = {'category', 'httpStatus', 'pathShape', 'pathnameSha256', 'serverRelativeSha256',
                      'serverPathWithinRoot', 'serverFileExists', 'queryPresent', 'hashPresent', 'sameOrigin'}
        if not isinstance(asset, dict) or set(asset) != asset_keys: raise SystemExit('Asset schema changed')
        if asset['category'] not in {'rayon-helper', 'method-worker', 'wasm', 'worker-other'}: raise SystemExit('Asset category changed')
        if asset['pathShape'] not in {'mode-assets-assets', 'mode-assets', 'mode-other', 'outside-mode'}: raise SystemExit('Asset route shape changed')
        for key in ('pathnameSha256', 'serverRelativeSha256'):
            if not isinstance(asset[key], str) or not re.fullmatch('[a-f0-9]{64}', asset[key]): raise SystemExit('Asset hash invalid')
        for key in ('serverPathWithinRoot', 'serverFileExists', 'queryPresent', 'hashPresent', 'sameOrigin'):
            if type(asset[key]) is not bool: raise SystemExit('Asset boolean invalid')
        status = asset['httpStatus']
        if value['stage'] == 'asset-http-failure':
            if type(status) is not int or not 400 <= status <= 599: raise SystemExit('Asset status invalid')
        elif status is not None: raise SystemExit('Request failure status invalid')
    if set(value) != allowed: raise SystemExit('Diagnostic schema changed')
    if len(records) >= 100: raise SystemExit('Diagnostic event bound exceeded')
    records.append({'event': match[1].lower(), **value})
result = proof / 'results.json'
summary = {'scope': 'one selected diagnostic only; no matrix or performance acceptance', 'case': case, 'full_declared_cases': 20, 'result_json_present': result.is_file(), 'events': records}
if result.is_file():
    data = json.loads(result.read_text())
    cases = []
    def walk(suite):
        for spec in suite.get('specs', []):
            for test in spec.get('tests', []):
                results = test.get('results', [])
                cases.append({'title': spec['title'], 'status': test.get('status'), 'results': [{'status': value.get('status'), 'retry': value.get('retry')} for value in results]})
        for child in suite.get('suites', []): walk(child)
    for suite in data.get('suites', []): walk(suite)
    if len(cases) != 1 or cases[0]['title'] != case: raise SystemExit('Expected exactly one selected diagnostic case')
    if data['config']['workers'] != 1 or any(project['retries'] != 0 for project in data['config']['projects']): raise SystemExit('Worker/retry constraints changed')
    summary['case_results'] = cases
    summary['runner_error_count'] = len(data.get('errors', []))
(proof / 'matrix-focused-diagnostic.json').write_text(json.dumps(summary, indent=2, sort_keys=True) + '\n')
print(json.dumps({'diagnostic_only': True, 'result_json_present': result.is_file(), 'event_count': len(records)}))
