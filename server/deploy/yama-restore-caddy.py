#!/usr/bin/env python3
"""Restore exact pre-test Caddyfile and retain the already-restored live config."""
import datetime,json,os,pathlib,shlex,shutil,subprocess,urllib.request
os.umask(0o077)
assert os.geteuid()==0,'Run the reviewed restore-caddy.sh as root'
base=pathlib.Path('/home/fansion/.local/share/tizi-server')
backup=pathlib.Path((base/'deployment-backup-path').read_text().strip())
original=backup/'Caddyfile';target=pathlib.Path('/etc/caddy/Caddyfile');st=target.stat()
runtime=json.load(urllib.request.urlopen('http://localhost:2019/config/'))
# The current live route must already be the original authenticated file server.
def handlers(x):
 if isinstance(x,dict):
  if 'handler'in x:yield x['handler']
  for v in x.values():yield from handlers(v)
 elif isinstance(x,list):
  for v in x:yield from handlers(v)
legacy=[]
for s in runtime['apps']['http']['servers'].values():
 for r in s.get('routes',[]):
  if any('sub.yama.fansionia.world'in m.get('host',[])for m in r.get('match',[])):legacy.append(r)
assert len(legacy)==1 and 'authentication'in list(handlers(legacy[0])) and 'file_server'in list(handlers(legacy[0])),'Restore legacy runtime first'
folder=base/'backups'/('before-root-restore-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));folder.mkdir(mode=0o700)
shutil.copyfile(target,folder/'Caddyfile');(folder/'Caddyfile').chmod(0o600)
(folder/'runtime.json').write_text(json.dumps(runtime));(folder/'runtime.json').chmod(0o600)
temp=pathlib.Path('/etc/caddy/Caddyfile.tizi-restore');shutil.copyfile(original,temp);os.chown(temp,st.st_uid,st.st_gid);os.chmod(temp,st.st_mode&0o777)
env=os.environ.copy()
for value in shlex.split(subprocess.run(['systemctl','show','caddy','-p','Environment','--value'],capture_output=True,text=True,check=True).stdout):
 if '='in value:
  k,v=value.split('=',1);env[k]=v
check=subprocess.run(['/usr/bin/caddy','validate','--adapter','caddyfile','--config',str(temp)],capture_output=True,text=True,env=env)
(base/'restore-validation.log').write_text(check.stdout+check.stderr);(base/'restore-validation.log').chmod(0o600)
assert check.returncode==0,'Validation failed; see private restore-validation.log'
os.replace(temp,target)
try:
 subprocess.run(['systemctl','reload','caddy'],check=True)
 # Reload from the exact original file, then retain original dynamic balance Header
 # and any unrelated live settings from immediately before this command.
 request=urllib.request.Request('http://localhost:2019/load',data=json.dumps(runtime).encode(),headers={'Content-Type':'application/json'},method='POST')
 with urllib.request.urlopen(request)as response:assert response.status==200
except Exception:
 shutil.copyfile(folder/'Caddyfile',target);os.chown(target,st.st_uid,st.st_gid);os.chmod(target,st.st_mode&0o777);raise
assert target.read_bytes()==original.read_bytes()
(base/'legacy-durable-restored').write_text(datetime.datetime.now().isoformat()+'\n')
print('Original Caddyfile restored byte-for-byte; original static file server, Basic Auth and dynamic Header retained. Independent test Rust service unchanged.')
