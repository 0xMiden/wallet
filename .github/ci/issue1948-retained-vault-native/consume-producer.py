#!/usr/bin/env python3
import hashlib, json, os, stat, subprocess, zipfile
from pathlib import Path
if os.environ.get('GITHUB_ACTIONS') != 'true': raise SystemExit('CI only')
root=Path(os.environ['GITHUB_WORKSPACE']); private=root/'producer-artifacts'; private.mkdir(exist_ok=False)
proof=root/'proof'; proof.mkdir(exist_ok=True)
expected={'resolve.log': 'dfb38f7c2de9c3a98cdabb2cbb881a9ee0fc7e5713346fef8999585cdce3c6c8', 'rustc-version.log': '778fbc643a806f0dd123c056e66201d7e8a56a61928ec0a33171be8d6c2d5a37', 'prebuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'producer-Cargo.lock': '178815e8f1f0388dea3460928c2d2eea2abdd23a1658b44b9e2aac0b4864bf7e', 'compile-receipt.json': '1a468747e6e402854c1ee5b61fae7489cbb8df2700819730ff3ad834a437663e', 'source.json': '27004673cd1aba6fc0738c4b8018705cf9d475bc68276fba498a2e3ccae88b4f', 'dependency-receipt.json': 'd8f9af952565416eb8d5ebf209319522cce2846c1b90559b3d6c163ebc7faa62', 'preservation.json': '44aa039a7bd0188a380f43be66d478d145aca9d2c2c02a27afb0cf88cdbe608a', 'compile.log': 'aba4af77f668132dbfafd3ff5a6efd64472597a3bccbacff34d92207b3ae2b3a', 'postbuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'toolchain.log': '51f74a7221c20ee9da8ea9c319e53c16d37e09681d39fa65223f2c3d7782687a', 'dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9'}
repo='repos/0xMiden/wallet'
def api(path): return json.loads(subprocess.check_output(['gh','api',repo+path]))
run=api('/actions/runs/40524043320')
if run['head_sha']!='b18844d43937953d88361e9a7192d212b9e80ad4' or run['run_attempt']!=1 or run['status']!='completed' or run['conclusion']!='success': raise RuntimeError('Compiled producer run binding')
artifacts=api('/actions/runs/40524043320/artifacts')['artifacts']
names=['controller-native-recovery-producer-40524043320-1','native-recovery-producer-binary-40524043320-1']
for name in names:
    matches=[a for a in artifacts if a['name']==name and not a['expired']]
    if len(matches)!=1 or matches[0]['size_in_bytes']>32*1024*1024: raise RuntimeError('Compiled artifact inventory')
    target=private/name; target.mkdir()
    subprocess.run(['gh','run','download','40524043320','--repo','0xMiden/wallet','--name',name,'--dir',str(target)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
metadata=private/names[0]
if {p.name for p in metadata.iterdir()}!=set(expected): raise RuntimeError('Compiled metadata closure')
for name,value in expected.items():
    if hashlib.sha256((metadata/name).read_bytes()).hexdigest()!=value: raise RuntimeError('Compiled metadata hash')
binary=private/names[1]/'wallet-recovery-native-fixtures'
if binary.stat().st_size!=16569528 or hashlib.sha256(binary.read_bytes()).hexdigest()!='5e1c774ff287212325b666b27a3b4cffcb427f07b296e5965eebacbbf99da703': raise RuntimeError('Compiled binary hash')
binary.chmod(0o700)
source=json.loads((metadata/'source.json').read_text())
if source['source']!='77dfdc67577e1be2f7e18a7efed3a589f2d64d71' or source['source_tree']!='4732c784c1ed869a95a5fee7d66583ffbc9c483e' or source['compile_only'] is not True: raise RuntimeError('Compiled source binding')
(proof/'compiled-producer-consumed.json').write_text(json.dumps({'run':40524043320,'source':source['source'],'tree':source['source_tree'],'metadata_hashes':expected,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'binary_bytes':binary.stat().st_size,'executed_in_consumer':False,'dependency_packages':536},indent=2)+'\n')
with Path(os.environ['GITHUB_ENV']).open('a') as stream: stream.write('RECOVERY_FIXTURE_PRODUCER='+str(binary)+'\n')
print('Bound verified compiled producer without execution')
