from pathlib import Path
import hashlib,json,os,stat,subprocess,sys
root=Path.cwd();proof=Path(os.environ['PROOF_DIR']);label=sys.argv[1]
def git(*args):return subprocess.check_output(['git',*args])
rows=[]
for entry in git('ls-files','-z','packages/bread-connect','packages/bread-connect-capacitor','yarn.lock','package.json','jest.config.ts','jest.setup.js').split(b'\0'):
 if not entry:continue
 name=os.fsdecode(entry);p=root/name;assert p.is_file() and not p.is_symlink();data=p.read_bytes();rows.append({'path':name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'mode':stat.S_IMODE(p.stat().st_mode)})
(proof/(label+'-source.json')).write_text(json.dumps(rows,indent=2)+'\n')
for name,args in [('identity.txt',['rev-parse','HEAD','HEAD^{tree}']),('stage.bin',['ls-files','--stage','-z']),('status.bin',['status','--porcelain=v1','-z'])]:(proof/(label+'-'+name)).write_bytes(git(*args))
index=Path(git('rev-parse','--path-format=absolute','--git-path','index').decode().strip());(proof/(label+'-index.bin')).write_bytes(index.read_bytes())
