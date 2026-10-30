#!/usr/bin/env python3
# Uses only new temporary state and fictional account data; never point it at production.
import os,json,subprocess,tempfile,pathlib,socket,urllib.request,urllib.error,time,sqlite3,contextlib
import argparse
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from http.client import HTTPConnection
class ProxyFixture(BaseHTTPRequestHandler):
 def do_GET(self):
  data=b"x"*32768
  self.send_response(200);self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)
 def do_CONNECT(self):
  self.send_response(200);self.end_headers();self.wfile.flush()
  while self.rfile.readline(8192) not in (b"\r\n", b"\n", b""):pass
  self.wfile.write(b"HTTP/1.1 200 OK\r\nContent-Length: 32768\r\nConnection: close\r\n\r\n"+b"x"*32768);self.wfile.flush();self.close_connection=True
 def log_message(self,*args):pass

parser=argparse.ArgumentParser(description='Manual isolated native integration with a fixture-key core and Caddy')
parser.add_argument('--server', required=True)
parser.add_argument('--core', required=True)
parser.add_argument('--caddy', required=True)
args=parser.parse_args()
ROOT=pathlib.Path(tempfile.mkdtemp(prefix='tizi-integration-')).resolve()
SERVER=str(pathlib.Path(args.server).resolve())
CORE=str(pathlib.Path(args.core).resolve())
CADDY=str(pathlib.Path(args.caddy).resolve())
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def cli(*args):return subprocess.run([SERVER,'--database',str(ROOT/'server.db'),*args],check=True,capture_output=True,text=True)
def native(action,payload={}):
 p=subprocess.run([CORE,'tizi','--state-dir',str(ROOT/'device'),action],input=json.dumps(payload),capture_output=True,text=True,timeout=40)
 r=json.loads(p.stdout)
 assert r.get('ok'),r
 return r['data']
def http(url,body=None):
 data=None if body is None else json.dumps(body).encode()
 return urllib.request.urlopen(urllib.request.Request(url,data,headers={'Content-Type':'application/json'}),timeout=5)
def wait(url):
 for _ in range(100):
  try:
   with http(url):return
  except Exception:time.sleep(.1)
 raise RuntimeError('listener not ready')
procs=[]
try:
 cli('init')
 upstream=ThreadingHTTPServer(('127.0.0.1',0),ProxyFixture)
 threading.Thread(target=upstream.serve_forever,daemon=True).start()
 yaml=ROOT/'source.yaml';yaml.write_text('proxies:\n  - name: paid\n    type: http\n    server: 127.0.0.1\n    port: UPSTREAM_PORT\n    username: fixture-user\n    password: fixture-only\nproxy-groups: []\nrules:\n  - IP-CIDR,127.0.0.0/8,DIRECT\n  - MATCH,paid\nexternal-controller: 0.0.0.0:54321\n')
 yaml.write_text(yaml.read_text().replace('UPSTREAM_PORT',str(upstream.server_port)))
 cli('publish','--file',str(yaml))
 backend,front=port(),port();origin=f'http://127.0.0.1:{front}'
 env=dict(os.environ,SMTP_HOST='127.0.0.1',SMTP_FROM='fixture@example.test',SMTP_USERNAME='fixture',SMTP_PASSWORD='fixture',SMTP_PORT='1')
 log=open(ROOT/'server.log','w');procs.append(subprocess.Popen([SERVER,'--database',str(ROOT/'server.db'),'serve','--listen',f'127.0.0.1:{backend}'],env=env,stdout=log,stderr=log))
 wait(f'http://127.0.0.1:{backend}/healthz')
 cfg=ROOT/'Caddyfile';cfg.write_text(f'{{\n admin off\n auto_https off\n}}\nhttp://127.0.0.1:{front} {{\n header subscription-userinfo "upload=123; download=456; total=10000; expire=2000000000"\n encode gzip zstd\n reverse_proxy 127.0.0.1:{backend}\n}}\n')
 caddylog=open(ROOT/'caddy.log','w');procs.append(subprocess.Popen([CADDY,'run','--config',str(cfg),'--adapter','caddyfile'],stdout=caddylog,stderr=caddylog));wait(origin+'/healthz')
 try:http(origin+'/v1/subscription');raise AssertionError('unauthenticated subscription allowed')
 except urllib.error.HTTPError as e:assert e.code==401
 mail='integration@example.test';credential='fixture-long-phrase-2026'
 r=native('register',{'server_url':origin,'email':mail});rid=r['request_id']
 assert native('registration-status',{'server_url':origin,'request_id':rid})['status']=='pending'
 with sqlite3.connect(ROOT/'server.db') as c:assert c.execute('select count(*) from outbox').fetchone()[0]==0
 cli('approve',mail)
 with sqlite3.connect(ROOT/'server.db') as c:code=c.execute('select code from outbox where email=?',(mail,)).fetchone()[0]
 native('complete-registration',{'server_url':origin,'email':mail,'code':code,'password':credential})
 state=native('login',{'server_url':origin,'email':mail,'password':credential,'device_name':'integration'})
 assert state['logged_in'] and state['subscription']=={'upload':123,'download':456,'total':10000,'expire':2000000000},state
 assert native('usage')['email']==mail
 native('sync')
 assert native('usage')['devices'][0]['health']=='healthy', 'native/server health contract differs'
 status=native('status');assert status['health']=='healthy',status
 for f in (ROOT/'device').glob('*.enc'):
  data=f.read_bytes()
  assert b'private-node.test' not in data and b'fixture-only' not in data and mail.encode() not in data
  assert f.stat().st_mode&0o777==0o600
 # Native configuration validation consumes encrypted profile with no plaintext materialization.
 mixed=port()
 wrapper=ROOT/'config.yaml';wrapper.write_text(f'tizi-managed:\n  state-dir: {ROOT}/device\nmixed-port: {mixed}\nexternal-controller-unix: {ROOT}/core.sock\n')
 check=subprocess.run([CORE,'-t','-d',str(ROOT),'-f',str(wrapper)],capture_output=True,text=True,timeout=30)
 assert check.returncode==0,(check.stdout,check.stderr)
 assert 'private-node.test' not in check.stdout+check.stderr
 assert 'private-node.test' not in wrapper.read_text()
 # The decrypted upstream public controller must never open.
 running=subprocess.Popen([CORE,'-d',str(ROOT),'-f',str(wrapper)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);procs.append(running)
 for _ in range(100):
  if (ROOT/'core.sock').exists():break
  assert running.poll() is None,'core startup failed'
  time.sleep(.1)
 assert (ROOT/'core.sock').exists(),'local controller unavailable'
 class UnixConnection(HTTPConnection):
  def connect(self):
   self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.connect(str(ROOT/'core.sock'))
 ctl=UnixConnection('localhost',timeout=5)
 ctl.request('PATCH','/configs',json.dumps({'log-level':'debug'}),{'Content-Type':'application/json'})
 response=ctl.getresponse();response.read();assert response.status==403,'managed debug logging could be enabled';ctl.close()
 with socket.socket() as s:assert s.connect_ex(('127.0.0.1',54321))!=0,'remote controller leaked'
 for target in ['http://accounting.invalid/payload',f'http://127.0.0.1:{upstream.server_port}/payload']:
  conn=HTTPConnection('127.0.0.1',mixed,timeout=10);conn.request('GET',target);response=conn.getresponse();data=response.read();conn.close()
  assert response.status==200 and len(data)==32768, (response.status,len(data))
 running.terminate();running.wait(timeout=15);procs.remove(running)
 native('logout')
 with sqlite3.connect(ROOT/'server.db') as c:
  total=c.execute('select sum(download) from usage').fetchone()[0]
  assert total is not None and 32768<=total<50000, ('proxy-only byte accounting',total)
 upstream.shutdown()
 # A damaged ledger must reject the existing enrollment, not reset its totals.
 ledger=ROOT/'device'/'ledger.enc';saved=ledger.read_bytes();ledger.write_bytes(b'corrupt')
 p=subprocess.run([CORE,'tizi','--state-dir',str(ROOT/'device'),'login'],input=json.dumps({'server_url':origin,'email':mail,'password':credential,'device_name':'integration'}),capture_output=True,text=True,timeout=30)
 assert not json.loads(p.stdout)['ok'],'corrupt accounting silently reset'
 ledger.write_bytes(saved)
 print('PASS: real Caddy + Rust + native enrollment, approval gating, signed auth, usage, Header, real proxy traffic excluding DIRECT with history disabled, encrypted files, managed config startup, remote-controller denial, corrupted-ledger rejection')
 print('Evidence directory:',ROOT)
finally:
 for p in reversed(procs):
  p.terminate()
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:p.kill();p.wait()
