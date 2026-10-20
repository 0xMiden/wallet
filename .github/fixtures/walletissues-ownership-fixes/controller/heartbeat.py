#!/usr/bin/env python3
import datetime,json,os,subprocess
from pathlib import Path
ROOT=Path.home()/'.local/state/wallet-handoff/2026-10-19'
pause=ROOT/'wallet-workflows-pause.json'
if pause.exists() and json.loads(pause.read_text()).get('status') == 'paused':
 print(json.dumps({'kind':'wallet_workflows_paused','reason':'Explicit user pause; no heartbeat or discovery ran.'}),flush=True)
 raise SystemExit(0)
owner=(ROOT/'owner').read_text().strip()
started=datetime.datetime.now(datetime.timezone.utc)
cmds=[
 ('walletissues_ownership_audit',['python3','-B',str(Path.home()/'.claude/skills/walletissues/ledger.py'),'--owner',owner,'ownership-audit']),
 ('walletissues_adopt',['python3','-B',str(Path.home()/'.claude/skills/walletissues/ledger.py'),'--owner',owner,'adopt']),
 ('walletissues_load',['python3','-B',str(Path.home()/'.claude/skills/walletissues/ledger.py'),'load']),
 ('walletissues_mine',['python3','-B',str(Path.home()/'.claude/skills/walletissues/ledger.py'),'--owner',owner,'mine']),
 ('walletissues_offered',['python3','-B',str(Path.home()/'.claude/skills/walletissues/ledger.py'),'offered']),
 ('walletissues_discovery',['python3','-B',str(Path.home()/'.claude/skills/walletissues/discover.py'),'--prs']),
 ('walletissues_status',['python3','-B',str(Path.home()/'.claude/skills/walletissues/status.py')]),
 ('walletsentry_status',['python3','-B',str(Path.home()/'.agents/skills/walletsentry/scripts/status.py')]),
 ('walletsentry_discovery',['python3','-B',str(Path.home()/'.agents/skills/walletsentry/scripts/discover.py')])]
results={}
for name,cmd in cmds:
 try:
  r=subprocess.run(cmd,capture_output=True,text=True,timeout=100)
  data={'exit_code':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
 except subprocess.TimeoutExpired:
  data={'exit_code':124,'stdout':'','stderr':'Heartbeat command timed out; retry next tick.'}
 results[name]=data
 if name.endswith('status') or name.endswith('discovery') or name.endswith('ownership_audit') or (name.endswith('adopt') and data['stdout'].strip()!='[]') or data['exit_code']:
  output='\n'.join(l for l in (data['stdout']+data['stderr']).splitlines() if not l.startswith('^ HEARTBEAT:'))
  output=output.replace(chr(0x2014),'-').replace(chr(0x2013),'-')
  print(json.dumps({'kind':name,'exit_code':data['exit_code'],'output':output}),flush=True)
finished=datetime.datetime.now(datetime.timezone.utc)
next_due=finished+datetime.timedelta(seconds=600)
state={'owner':owner,'started':started.isoformat(),'finished':finished.isoformat(),'next_due':next_due.isoformat(),'results':results}
tmp=ROOT/'heartbeat.json.tmp';tmp.write_text(json.dumps(state,indent=2)+'\n');tmp.chmod(0o600);tmp.replace(ROOT/'heartbeat.json')
with (ROOT/'heartbeat-history.jsonl').open('a') as f:f.write(json.dumps({'started':state['started'],'finished':state['finished'],'next_due':state['next_due'],'exit_codes':{k:v['exit_code'] for k,v in results.items()}})+'\n')
print(json.dumps({'kind':'heartbeat_complete','finished':state['finished'],'next_due':state['next_due']}),flush=True)
