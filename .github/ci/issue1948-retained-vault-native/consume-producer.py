#!/usr/bin/env python3
import hashlib, json, os, stat, subprocess, zipfile
from pathlib import Path
if os.environ.get('GITHUB_ACTIONS') != 'true': raise SystemExit('CI only')
root=Path(os.environ['GITHUB_WORKSPACE']); private=root/'producer-artifacts'; private.mkdir(exist_ok=False)
proof=root/'proof'; proof.mkdir(exist_ok=True)
expected={'resolve.log': 'cea9c481e8fd728a13a2c7d523aaa4387018be0a64d628c4cddd2a351788f931', 'rustc-version.log': '778fbc643a806f0dd123c056e66201d7e8a56a61928ec0a33171be8d6c2d5a37', 'prebuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'producer-Cargo.lock': '178815e8f1f0388dea3460928c2d2eea2abdd23a1658b44b9e2aac0b4864bf7e', 'compile-receipt.json': 'f59e466551752af1b7d6fa464d369d29017bc4ab0c7c89eacab3165ef7fb4056', 'source.json': '1d06cb739bb0b8e2c98b2d3f0e593b8db6d13d8f248b8617a0bbde48db493b03', 'dependency-receipt.json': 'd8f9af952565416eb8d5ebf209319522cce2846c1b90559b3d6c163ebc7faa62', 'preservation.json': 'faeb7c5013abbc8400d79b4a3edda74f177645e3053c1babe41ea8a30d3652ed', 'compile.log': 'b9ea73c890693dad2f39c25d82e21092f598e5fc3095bc96724c396a29301404', 'postbuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'toolchain.log': '51f74a7221c20ee9da8ea9c319e53c16d37e09681d39fa65223f2c3d7782687a', 'dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9'}
repo='repos/0xMiden/wallet'
def api(path): return json.loads(subprocess.check_output(['gh','api',repo+path]))
run=api('/actions/runs/40774388151')
if run['head_sha']!='3e3a301c2f31dfc4fc41bf04f038025ffd437e69' or run['run_attempt']!=1 or run['status']!='completed' or run['conclusion']!='success': raise RuntimeError('Compiled producer run binding')
artifacts=api('/actions/runs/40774388151/artifacts')['artifacts']
names=['controller-native-recovery-producer-40774388151-1','native-recovery-producer-binary-40774388151-1']
for name in names:
    matches=[a for a in artifacts if a['name']==name and not a['expired']]
    if len(matches)!=1 or matches[0]['size_in_bytes']>32*1024*1024: raise RuntimeError('Compiled artifact inventory')
    target=private/name; target.mkdir()
    subprocess.run(['gh','run','download','40774388151','--repo','0xMiden/wallet','--name',name,'--dir',str(target)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
metadata=private/names[0]
if {p.name for p in metadata.iterdir()}!=set(expected): raise RuntimeError('Compiled metadata closure')
for name,value in expected.items():
    if hashlib.sha256((metadata/name).read_bytes()).hexdigest()!=value: raise RuntimeError('Compiled metadata hash')
binary=private/names[1]/'wallet-recovery-native-fixtures'
if binary.stat().st_size!=16716232 or hashlib.sha256(binary.read_bytes()).hexdigest()!='daf0390d4b68213fe21e8a620d879b12f8eea0a1362966cb1974eb4aa42bfb96': raise RuntimeError('Compiled binary hash')
binary.chmod(0o700)
source=json.loads((metadata/'source.json').read_text())
if source['source']!='55f99e97ccad0e3e11aa9853c146f148e53b15ea' or source['source_tree']!='9014a242cca17b6fc91e3ec0586b9c64490c1de4' or source['compile_only'] is not True: raise RuntimeError('Compiled source binding')
(proof/'compiled-producer-consumed.json').write_text(json.dumps({'run':40774388151,'source':source['source'],'tree':source['source_tree'],'metadata_hashes':expected,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'binary_bytes':binary.stat().st_size,'executed_in_consumer':False,'dependency_packages':536},indent=2)+'\n')
with Path(os.environ['GITHUB_ENV']).open('a') as stream: stream.write('RECOVERY_FIXTURE_PRODUCER='+str(binary)+'\n')
print('Bound verified compiled producer without execution')
