"""Real UID/session/core boundaries on a disposable macOS CI runner."""
import http.client
import http.server
import json
import os
import socket
import socketserver
import struct
import subprocess
import threading
import time
from pathlib import Path

if os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('This acceptance test may only run on a disposable GitHub macOS runner')

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
# Verify the root permission path with a real utun device, while leaving the
# runner's default routes and system DNS untouched.
existing = subprocess.check_output(['/sbin/ifconfig', '-l'], text=True).split()
device = next('utun' + str(n) for n in range(200, 250) if 'utun' + str(n) not in existing)
tun_config = config.replace('tun:\n  enable: false', 'tun:\n  enable: true\n  device: ' + device +
                            '\n  stack: system\n  auto-route: false\n  auto-detect-interface: false')
request('POST', '/v1/core/config', {'config': tun_config, 'files': []}, token)
deadline = time.monotonic() + 10
while device not in subprocess.check_output(['/sbin/ifconfig', '-l'], text=True).split():
    assert time.monotonic() < deadline, 'managed root core did not create its utun device'
    request('POST', '/v1/lease', {}, token)
    time.sleep(.25)
request('POST', '/v1/lease', {}, token)
# Without lease renewal a live privileged core must be stopped by the daemon.
deadline = time.monotonic() + 25
while request('GET', '/v1/status')['running']:
    assert time.monotonic() < deadline, 'expired lease left privileged core running'
    time.sleep(.5)
assert device not in subprocess.check_output(['/sbin/ifconfig', '-l'], text=True).split(), 'utun device leaked after core exit'
print('Real service UID, snapshot, core API, reload, utun creation/cleanup, and lease checks passed')

# Test the published, privately keyed native core through the real root helper.
# This local fixture exercises client encryption and the helper boundary; server
# authentication policy is covered by the independent Rust server tests.
port_file = Path(os.environ['RUNNER_TEMP']) / 'momo-tizi-fixture-port'
fixture_port = int(port_file.read_text()) if port_file.exists() else 0


class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send_json(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        if self.path == '/v1/login':
            self.send_json({'device_id': body['device_id'], 'email': body['email']})
        elif self.path == '/v1/usage/report':
            self.send_json({'sequence': body['sequence']})
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path != '/v1/subscription':
            self.send_error(404)
            return
        data = f'''mixed-port: 0
port: 0
socks-port: 0
log-level: info
external-controller: 127.0.0.1:{forbidden_controller_port}
dns:
  enable: false
tun:
  enable: false
proxies:
  - name: ci-tizi-node
    type: http
    server: 127.0.0.1
    port: 9
proxy-groups:
  - name: ci-tizi-group
    type: select
    proxies: [ci-tizi-auto, ci-tizi-node, DIRECT]
  - name: ci-tizi-auto
    type: url-test
    proxies: [ci-tizi-node]
    url: http://127.0.0.1:9
    interval: 86400
rules:
  - DOMAIN,managed-smart-test.invalid,ci-tizi-auto
  - MATCH,DIRECT
'''.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/yaml')
        self.send_header('Subscription-Userinfo', 'upload=10; download=20; total=100; expire=2000000000')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


fixture = http.server.ThreadingHTTPServer(('127.0.0.1', fixture_port), Fixture)
port_file.write_text(str(fixture.server_port))
probe = socket.socket()
probe.bind(('127.0.0.1', 0))
forbidden_controller_port = probe.getsockname()[1]
thread = threading.Thread(target=fixture.serve_forever, daemon=True)
thread.start()
probe.close()  # Keep the forbidden controller port distinct from the fixture's own listener.
lease_stop = threading.Event()
lease_errors = []


def renew_tizi_lease():
    while not lease_stop.wait(2):
        try:
            request('POST', '/v1/lease', {}, token)
        except Exception as error:
            lease_errors.append(str(error))
            return


lease_thread = None


class LocalDnsFixture(socketserver.BaseRequestHandler):
    def handle(self):
        packet, udp = self.request
        end = 12
        while packet[end]:
            end += packet[end] + 1
        question = packet[12:end + 5]
        # A private test answer; no public DNS, system resolver changes or routes.
        response = packet[:2] + struct.pack('!HHHHH', 0x8180, 1, 1, 0, 0) + question
        response += b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 30, 4) + socket.inet_aton('203.0.113.7')
        udp.sendto(response, self.client_address)


dns_fixture = socketserver.ThreadingUDPServer(('127.0.0.1', 0), LocalDnsFixture)
dns_thread = threading.Thread(target=dns_fixture.serve_forever, daemon=True)
dns_thread.start()
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as dns_probe:
    dns_probe.bind(('127.0.0.1', 0))
    dns_listen_port = dns_probe.getsockname()[1]
try:
    token = request('POST', '/v1/session', {})['token']
    lease_thread = threading.Thread(target=renew_tizi_lease, daemon=True)
    lease_thread.start()
    request('POST', '/v1/tizi/action', {'action': 'status'}, expected=401)
    native = request('POST', '/v1/tizi/action', {'action': 'status'}, token)
    assert native['ok'] and native['data']['supported'] and native['data']['keyReady']
    assert native['data']['managed_config_version'] >= 2
    login = request('POST', '/v1/tizi/action', {'action': 'login', 'payload': {
        'server_url': 'http://127.0.0.1:' + str(fixture.server_port),
        'email': 'ci@example.invalid', 'password': 'ci-only-password-123', 'device_name': 'macOS CI'
    }}, token)
    assert login['ok'] and login['data']['logged_in']
    assert login['data']['subscription']['upload'] == 10
    status = request('GET', '/v1/status')
    account_root = os.path.join(os.path.dirname(status['workDir']), 'tizi')
    assert status['workDir'] == '/Library/Application Support/world.fansionia.clash-momo/data'
    assert account_root == '/Library/Application Support/world.fansionia.clash-momo/tizi'
    # lstat(directory) only needs search permission on its parent. The legacy
    # migration fixture intentionally leaves that parent 0755; account contents
    # must still be inaccessible behind the root-owned 0700 account directory.
    try:
        os.listdir(account_root)
    except PermissionError:
        pass
    else:
        raise AssertionError('ordinary application UID can list protected account contents')
    for private_name in ('identity.enc', 'subscription.enc', 'ledger.enc'):
        try:
            with open(os.path.join(account_root, private_name), 'rb') as private_file:
                private_file.read(1)
        except PermissionError:
            pass
        else:
            raise AssertionError('ordinary application UID can read protected account contents')
    managed_config = 'tizi-managed:\n  state-dir: ' + json.dumps(account_root) + '\n'
    managed_config += '''  smart:
    enabled: true
    useLightGBM: false
    collectData: false
    collectorSize: 100
dns:
  enable: true
  ipv6: false
  enhanced-mode: redir-host
  listen: 127.0.0.1:''' + str(dns_listen_port) + '''
  nameserver: [127.0.0.1:''' + str(dns_fixture.server_address[1]) + ''']
  default-nameserver: [127.0.0.1:''' + str(dns_fixture.server_address[1]) + ''']
'''
    request('POST', '/v1/core/start', {'config': managed_config, 'files': []}, token)
    deadline = time.monotonic() + 15
    while True:
        request('POST', '/v1/lease', {}, token)
        try:
            proxies = request('GET', '/core/proxies', token=token)['proxies']
            if 'ci-tizi-node' in proxies and 'ci-tizi-group' in proxies:
                break
        except (OSError, http.client.HTTPException, AssertionError):
            pass
        assert time.monotonic() < deadline, 'silent managed core did not load its sealed configuration'
        time.sleep(.1)
    assert request('GET', '/core/configs', token=token)['log-level'] == 'silent'
    smart_names = [name for name, proxy in proxies.items() if proxy.get('type', '').lower() == 'smart']
    assert len(smart_names) == 1
    assert smart_names[0] in proxies['ci-tizi-group']['all']
    assert 'ci-tizi-auto' not in proxies
    assert any(rule['proxy'] == smart_names[0] for rule in request('GET', '/core/rules', token=token)['rules'])
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as dns_client:
        dns_client.settimeout(.5)
        question = b'\x0amanaged-ci\x07invalid\0' + struct.pack('!HH', 1, 1)
        query = b'\x12\x34' + struct.pack('!HHHHH', 0x0100, 1, 0, 0, 0) + question
        deadline = time.monotonic() + 10
        while True:
            dns_client.sendto(query, ('127.0.0.1', dns_listen_port))
            try:
                answer, _ = dns_client.recvfrom(4096)
                break
            except socket.timeout:
                assert time.monotonic() < deadline, 'controlled DNS listener did not answer on its private port'
        assert answer[:2] == b'\x12\x34' and answer[3] & 15 == 0
        assert socket.inet_aton('203.0.113.7') in answer
    with socket.socket() as remote_probe:
        remote_probe.settimeout(1)
        assert remote_probe.connect_ex(('127.0.0.1', forbidden_controller_port)) != 0
    request('PATCH', '/core/configs', {'log-level': 'info'}, token, expected=403)
    request('POST', '/v1/core/config', {'config': managed_config, 'files': [
        {'path': '../tizi/ledger.enc', 'data': 'eA=='}]}, token, expected=400)
    request('POST', '/v1/core/config', {'config': 'tizi-managed:\n  state-dir: /tmp/foreign-account\n',
                                      'files': []}, token, expected=400)
    assert request('GET', '/v1/status')['running']
    request('POST', '/v1/core/stop', {}, token)
    exported = request('GET', '/v1/core/state', token=token)
    assert all(not item['path'].startswith('tizi/') for item in exported['files'])
    account_files = [os.path.join(account_root, name) for name in ('identity.enc', 'subscription.enc', 'ledger.enc')]
    original_hashes = subprocess.check_output(['sudo', '/usr/bin/shasum', '-a', '256', *account_files])
    request('POST', '/v1/core/start', {'config': config, 'files': []}, token)
    request('POST', '/v1/core/stop', {}, token)
    assert subprocess.check_output(['sudo', '/usr/bin/shasum', '-a', '256', *account_files]) == original_hashes
    assert not lease_errors, lease_errors
    print('Published tizi key, real helper bridge, sealed startup, remote controller denial, protected state and private-profile return passed')
finally:
    lease_stop.set()
    if lease_thread:
        lease_thread.join(timeout=5)
    fixture.shutdown()
    fixture.server_close()
    thread.join(timeout=2)
    dns_fixture.shutdown()
    dns_fixture.server_close()
    dns_thread.join(timeout=2)
