#!/usr/bin/env python3
import hashlib, json, os, stat, subprocess, zipfile
from pathlib import Path
if os.environ.get('GITHUB_ACTIONS') != 'true': raise SystemExit('CI only')
root=Path(os.environ['GITHUB_WORKSPACE']); private=root/'producer-artifacts'; private.mkdir(exist_ok=False)
proof=root/'proof'; proof.mkdir(exist_ok=True)
expected={'resolve.log': 'cea9c481e8fd728a13a2c7d523aaa4387018be0a64d628c4cddd2a351788f931', 'rustc-version.log': '778fbc643a806f0dd123c056e66201d7e8a56a61928ec0a33171be8d6c2d5a37', 'prebuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'producer-Cargo.lock': '178815e8f1f0388dea3460928c2d2eea2abdd23a1658b44b9e2aac0b4864bf7e', 'compile-receipt.json': '7ea797d4d5e69d3b3b1f2b992a75aae44dab35bdf0c1c7515355771c976e127a', 'source.json': 'aa4e3353321afd1de2343c0050c14015094a2f0d9e5a04cdc6dd0ffa1d313055', 'dependency-receipt.json': 'd8f9af952565416eb8d5ebf209319522cce2846c1b90559b3d6c163ebc7faa62', 'preservation.json': 'ad06ef3bb585ccddc1d84b3bcd334023bf462ce29ff50a33c1567274fc884c0a', 'compile.log': '988021403659d18f4602a20283516c4db8d59577e190b2c27ca8f1fce57b1b70', 'postbuild-dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9', 'toolchain.log': '51f74a7221c20ee9da8ea9c319e53c16d37e09681d39fa65223f2c3d7782687a', 'dependency-verify.log': '885e4a8f4bcd25b34601a5c0fb1cfb0825310a65b9c06fb431e148ef5639aba9'}
repo='repos/0xMiden/wallet'
def api(path): return json.loads(subprocess.check_output(['gh','api',repo+path]))
run=api('/actions/runs/40787834620')
if run['head_sha']!='a63570cda4f3fd2b86cf2ee1aeb07569ebeb5042' or run['run_attempt']!=1 or run['status']!='completed' or run['conclusion']!='success': raise RuntimeError('Compiled producer run binding')
artifacts=api('/actions/runs/40787834620/artifacts')['artifacts']
names=['controller-native-recovery-producer-40787834620-1','native-recovery-producer-binary-40787834620-1']
for name in names:
    matches=[a for a in artifacts if a['name']==name and not a['expired']]
    if len(matches)!=1 or matches[0]['size_in_bytes']>32*1024*1024: raise RuntimeError('Compiled artifact inventory')
    target=private/name; target.mkdir()
    subprocess.run(['gh','run','download','40787834620','--repo','0xMiden/wallet','--name',name,'--dir',str(target)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
metadata=private/names[0]
if {p.name for p in metadata.iterdir()}!=set(expected): raise RuntimeError('Compiled metadata closure')
for name,value in expected.items():
    if hashlib.sha256((metadata/name).read_bytes()).hexdigest()!=value: raise RuntimeError('Compiled metadata hash')
binary=private/names[1]/'wallet-recovery-native-fixtures'
if binary.stat().st_size!=17894344 or hashlib.sha256(binary.read_bytes()).hexdigest()!='03dc14e351974045f751c19725529fe3858b1ae65766b2135a945d6a893b1bed': raise RuntimeError('Compiled binary hash')
binary.chmod(0o700)
source=json.loads((metadata/'source.json').read_text())
if source['source']!='b96cde51af77e64b99139f9f7d0a4fa0197d8a49' or source['source_tree']!='120ee0623215ecf4c86bc03432ac2964d2f6ac9c' or source['compile_only'] is not True: raise RuntimeError('Compiled source binding')
(proof/'compiled-producer-consumed.json').write_text(json.dumps({'run':40787834620,'source':source['source'],'tree':source['source_tree'],'metadata_hashes':expected,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'binary_bytes':binary.stat().st_size,'executed_in_consumer':False,'dependency_packages':536},indent=2)+'\n')
with Path(os.environ['GITHUB_ENV']).open('a') as stream: stream.write('RECOVERY_FIXTURE_PRODUCER='+str(binary)+'\n')
print('Bound verified compiled producer without execution')
