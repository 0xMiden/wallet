#!/usr/bin/env python3
import hashlib, json, os, stat, subprocess, zipfile
from pathlib import Path
if os.environ.get('GITHUB_ACTIONS') != 'true': raise SystemExit('CI only')
root=Path(os.environ['GITHUB_WORKSPACE']); private=root/'producer-artifacts'; private.mkdir(exist_ok=False)
proof=root/'proof'; proof.mkdir(exist_ok=True)
expected={'resolve.log': 'cea9c481e8fd728a13a2c7d523aaa4387018be0a64d628c4cddd2a351788f931', 'rustc-version.log': '778fbc643a806f0dd123c056e66201d7e8a56a61928ec0a33171be8d6c2d5a37', 'prebuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'producer-Cargo.lock': '178815e8f1f0388dea3460928c2d2eea2abdd23a1658b44b9e2aac0b4864bf7e', 'compile-receipt.json': 'a576cf734e5f027312c202655b5b9ac0cf69b0e40c1f25e2830a36d525cf39a7', 'source.json': 'dd5f932ce951a18543c983fea1003dd25c31cf66f35ce43ede49ff897871c200', 'dependency-receipt.json': 'd8f9af952565416eb8d5ebf209319522cce2846c1b90559b3d6c163ebc7faa62', 'preservation.json': '531279b200859f45ddd3ce657219460ffcde99ea0f9833800f1827fc56e6e71f', 'compile.log': '2b10033202cd9559f954ef3401c5d63f24c3413d7cb20421476f21a5a734b489', 'postbuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'toolchain.log': '51f74a7221c20ee9da8ea9c319e53c16d37e09681d39fa65223f2c3d7782687a', 'dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9'}
repo='repos/0xMiden/wallet'
def api(path): return json.loads(subprocess.check_output(['gh','api',repo+path]))
run=api('/actions/runs/40783300967')
if run['head_sha']!='eb229f3fda2e06dfef97e7d9acdcee1cbe3878d8' or run['run_attempt']!=1 or run['status']!='completed' or run['conclusion']!='success': raise RuntimeError('Compiled producer run binding')
artifacts=api('/actions/runs/40783300967/artifacts')['artifacts']
names=['controller-native-recovery-producer-40783300967-1','native-recovery-producer-binary-40783300967-1']
for name in names:
    matches=[a for a in artifacts if a['name']==name and not a['expired']]
    if len(matches)!=1 or matches[0]['size_in_bytes']>32*1024*1024: raise RuntimeError('Compiled artifact inventory')
    target=private/name; target.mkdir()
    subprocess.run(['gh','run','download','40783300967','--repo','0xMiden/wallet','--name',name,'--dir',str(target)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
metadata=private/names[0]
if {p.name for p in metadata.iterdir()}!=set(expected): raise RuntimeError('Compiled metadata closure')
for name,value in expected.items():
    if hashlib.sha256((metadata/name).read_bytes()).hexdigest()!=value: raise RuntimeError('Compiled metadata hash')
binary=private/names[1]/'wallet-recovery-native-fixtures'
if binary.stat().st_size!=17268136 or hashlib.sha256(binary.read_bytes()).hexdigest()!='b86128e63f0e8bbdeb6a3a29c443a48c79a94ed173d59264179c1dde62476f50': raise RuntimeError('Compiled binary hash')
binary.chmod(0o700)
source=json.loads((metadata/'source.json').read_text())
if source['source']!='0be404fd47d00a8c422b7e6faa67f8c17d0ad7ea' or source['source_tree']!='d174e4d09891f0b6aa7b29cf33d3748a57d71261' or source['compile_only'] is not True: raise RuntimeError('Compiled source binding')
(proof/'compiled-producer-consumed.json').write_text(json.dumps({'run':40783300967,'source':source['source'],'tree':source['source_tree'],'metadata_hashes':expected,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'binary_bytes':binary.stat().st_size,'executed_in_consumer':False,'dependency_packages':536},indent=2)+'\n')
with Path(os.environ['GITHUB_ENV']).open('a') as stream: stream.write('RECOVERY_FIXTURE_PRODUCER='+str(binary)+'\n')
print('Bound verified compiled producer without execution')
