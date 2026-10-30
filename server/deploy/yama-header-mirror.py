#!/usr/bin/env python3
"""Read original Caddy's subscription header; write only the independent test proxy."""
import copy,json,os,pathlib,urllib.request
os.umask(0o077)
BASE=pathlib.Path('/home/fansion/.local/share/tizi-server')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def read(url):return json.load(opener.open(url,timeout=5))
def header(node):
 if isinstance(node,dict):
  for key,value in node.get('response',{}).get('set',{}).items():
   if key.lower()=='subscription-userinfo':return value[0]
  for value in node.values():
   found=header(value)
   if found is not None:return found
 elif isinstance(node,list):
  for value in node:
   found=header(value)
   if found is not None:return found
 return None
original=read('http://localhost:2019/config/')
found=[]
for server in original.get('apps',{}).get('http',{}).get('servers',{}).values():
 for route in server.get('routes',[]):
  if any('sub.yama.fansionia.world'in match.get('host',[])for match in route.get('match',[])):found.append(header(route))
assert len(found)==1 and found[0] and all(k+'='in found[0]for k in ['upload','download','total','expire']),'Original balance header unavailable; cached proxy preserved'
metadata=found[0]
config={'admin':{'listen':'127.0.0.1:2021','config':{'persist':False}},'apps':{'http':{'servers':{'tizi_test':{'listen':['127.0.0.1:9878'],'automatic_https':{'disable':True},'routes':[{'handle':[{'handler':'headers','response':{'set':{'Subscription-Userinfo':[metadata],'Cache-Control':['no-store']}}},{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:9876'}]}]}]}}}}}
path=BASE/'proxy.json';temporary=BASE/'proxy.json.new';temporary.write_text(json.dumps(config));temporary.chmod(0o600);os.replace(temporary,path)
try:current=read('http://127.0.0.1:2021/config/')
except Exception:
 print('Independent proxy config prepared; original service untouched')
else:
 if header(current)!=metadata:
  request=urllib.request.Request('http://127.0.0.1:2021/load',data=json.dumps(config).encode(),headers={'Content-Type':'application/json'},method='POST')
  with opener.open(request,timeout=5)as response:assert response.status==200
 print('Independent header mirror healthy; original service read only')
