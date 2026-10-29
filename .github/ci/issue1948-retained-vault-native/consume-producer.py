#!/usr/bin/env python3
import hashlib, json, os, stat, subprocess, zipfile
from pathlib import Path
if os.environ.get('GITHUB_ACTIONS') != 'true': raise SystemExit('CI only')
root=Path(os.environ['GITHUB_WORKSPACE']); private=root/'producer-artifacts'; private.mkdir(exist_ok=False)
proof=root/'proof'; proof.mkdir(exist_ok=True)
expected={'resolve.log': 'cea9c481e8fd728a13a2c7d523aaa4387018be0a64d628c4cddd2a351788f931', 'rustc-version.log': '778fbc643a806f0dd123c056e66201d7e8a56a61928ec0a33171be8d6c2d5a37', 'prebuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'producer-Cargo.lock': '178815e8f1f0388dea3460928c2d2eea2abdd23a1658b44b9e2aac0b4864bf7e', 'compile-receipt.json': 'e632defa17c64c6fe24f7b0c38800c82d2189543f81efae4fb5c542e3bf72430', 'source.json': 'c0049c2525e70fb48cfbd1853d339e30d1f063981c7f07d978760506e1a26bc6', 'dependency-receipt.json': 'd8f9af952565416eb8d5ebf209319522cce2846c1b90559b3d6c163ebc7faa62', 'preservation.json': '30b4cd02850b535b551f13d3bc4a8b6b66bb204cdd166c07cb703484823b9fcf', 'compile.log': 'a98014ee0b29829f47815ef25d3a8c32554080f4718c2bba5c6217e84ae3968d', 'postbuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'toolchain.log': '51f74a7221c20ee9da8ea9c319e53c16d37e09681d39fa65223f2c3d7782687a', 'dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9'}
repo='repos/0xMiden/wallet'
def api(path): return json.loads(subprocess.check_output(['gh','api',repo+path]))
run=api('/actions/runs/40789951507')
if run['head_sha']!='b27dd63d2c97908b5f8e8e31f49afaea319e4e38' or run['run_attempt']!=1 or run['status']!='completed' or run['conclusion']!='success': raise RuntimeError('Compiled producer run binding')
artifacts=api('/actions/runs/40789951507/artifacts')['artifacts']
names=['controller-native-recovery-producer-40789951507-1','native-recovery-producer-binary-40789951507-1']
for name in names:
    matches=[a for a in artifacts if a['name']==name and not a['expired']]
    if len(matches)!=1 or matches[0]['size_in_bytes']>32*1024*1024: raise RuntimeError('Compiled artifact inventory')
    target=private/name; target.mkdir()
    subprocess.run(['gh','run','download','40789951507','--repo','0xMiden/wallet','--name',name,'--dir',str(target)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
metadata=private/names[0]
if {p.name for p in metadata.iterdir()}!=set(expected): raise RuntimeError('Compiled metadata closure')
for name,value in expected.items():
    if hashlib.sha256((metadata/name).read_bytes()).hexdigest()!=value: raise RuntimeError('Compiled metadata hash')
binary=private/names[1]/'wallet-recovery-native-fixtures'
if binary.stat().st_size!=17915672 or hashlib.sha256(binary.read_bytes()).hexdigest()!='dc10ac07a54fa86ee689725ddb30ec3587e021c5a0672f91bef320493fa0e2a1': raise RuntimeError('Compiled binary hash')
binary.chmod(0o700)
source=json.loads((metadata/'source.json').read_text())
if source['source']!='d89fc4f441425cbcc90db49983d664c74b5bcb58' or source['source_tree']!='c6ab88fc6f6954c89c24c95e0140d2f94a0f8566' or source['compile_only'] is not True: raise RuntimeError('Compiled source binding')
(proof/'compiled-producer-consumed.json').write_text(json.dumps({'run':40789951507,'source':source['source'],'tree':source['source_tree'],'metadata_hashes':expected,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'binary_bytes':binary.stat().st_size,'executed_in_consumer':False,'dependency_packages':536},indent=2)+'\n')
with Path(os.environ['GITHUB_ENV']).open('a') as stream: stream.write('RECOVERY_FIXTURE_PRODUCER='+str(binary)+'\n')
print('Bound verified compiled producer without execution')
