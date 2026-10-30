"""Real UID/session/core boundaries on a disposable macOS CI runner."""
import http.client
import json
import os
import socket
import subprocess
import time

SOCKET = '/Library/PrivilegedHelperTools/world.fansionia.clash-momo.ipc/helper.sock'


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)


def request(method, path, body=None, token=None, expected=200):
    conn = UnixHTTP('localhost', timeout=45)
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['X-Momo-Session'] = token
    conn.request(method, path, None if body is None else json.dumps(body), headers)
    response = conn.getresponse()
    data = response.read()
    conn.close()
    assert response.status == expected, (path, response.status, data[:200])
    return json.loads(data) if data and expected == 200 else None


for attempt in range(100):
    try:
        status = request('GET', '/v1/status')
        break
    except (OSError, http.client.HTTPException):
        time.sleep(.1)
else:
    raise AssertionError('service did not become ready')
assert status['protocol'] == 1 and status['uid'] == os.getuid()
assert not status['running']
request('POST', '/v1/core/start', {}, expected=401)
token = request('POST', '/v1/session', {})['token']
request('POST', '/v1/session', {}, expected=409)
request('POST', '/v1/lease', {}, 'incorrect', expected=401)
request('POST', '/v1/core/start', {'config': 'mode: direct\n', 'files': [
    {'path': '../escape', 'data': 'eA=='}]}, token, expected=400)
config = '''mode: direct
mixed-port: 0
log-level: warning
dns:
  enable: false
tun:
  enable: false
traffic-history:
  enable: true
  path: traffic-history.db
  geoip:
    enable: false
'''
request('POST', '/v1/core/start', {'config': config, 'files': []}, token)
request('POST', '/v1/lease', {}, token)
status = request('GET', '/v1/status')
assert status['running'] and status['pid'] > 1
version = request('GET', '/core/version', token=token)
assert version['version'] == '1.19.33'
assert request('GET', '/core/traffic-history/status', token=token)['enabled']
request('POST', '/core/upgrade', {}, token, expected=403)
request('POST', '/core/restart', {}, token, expected=403)
request('PUT', '/core/configs', {'path': '/etc/passwd'}, token, expected=403)
assert subprocess.run(['sudo', '-u', 'nobody', '/usr/bin/curl', '--max-time', '2',
                       '--unix-socket', SOCKET, 'http://localhost/v1/status'],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
request('POST', '/v1/core/config', {'config': config, 'files': []}, token)
request('POST', '/v1/lease', {}, token)
# Without lease renewal a live privileged core must be stopped by the daemon.
deadline = time.monotonic() + 25
while request('GET', '/v1/status')['running']:
    assert time.monotonic() < deadline, 'expired lease left privileged core running'
    time.sleep(.5)
print('Real service UID, snapshot, core API, reload, and lease checks passed')
