#!/usr/bin/env python3
"""Real proxy/history/restart acceptance; optional native Windows TUN lifecycle."""
import argparse
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('binary', type=Path)
parser.add_argument('--tun', action='store_true')
args = parser.parse_args()
binary = args.binary.resolve()
payload = b'mihomomo-windows-history-acceptance\n' * 4096


class Origin(http.server.BaseHTTPRequestHandler):
    def do_CONNECT(self):
        # A local HTTP outbound terminates the synthetic TUN target. No Internet
        # access or default-route changes are needed to exercise the data path.
        assert self.path == '198.19.0.1:80', self.path
        self.send_response(200)
        self.end_headers()
        self.wfile.flush()
        line = self.rfile.readline()
        assert line.startswith(b'GET '), line
        while self.rfile.readline() not in (b'\r\n', b'\n', b''):
            pass
        self.wfile.write(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(payload)).encode()
                         + b'\r\nConnection: close\r\n\r\n' + payload)
        self.wfile.flush()
        self.close_connection = True

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_for(check, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError, KeyError) as error:
            last = error
        time.sleep(0.2)
    raise AssertionError(f'Acceptance condition timed out: {last}')


def adapters():
    value = subprocess.check_output([
        'powershell', '-NoProfile', '-NonInteractive', '-Command',
        "@(Get-NetAdapter -IncludeHidden | Where-Object Name -eq 'Momo CI TUN' | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"
    ], text=True).strip()
    return json.loads(value) if value else []


origin = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Origin)
threading.Thread(target=origin.serve_forever, daemon=True).start()
control, proxy = free_port(), free_port()
direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path, method='GET', data=None):
    request = urllib.request.Request(f'http://127.0.0.1:{control}{path}', method=method,
                                     headers={'Authorization': 'Bearer acceptance-secret',
                                              'Content-Type': 'application/json'},
                                     data=None if data is None else json.dumps(data).encode())
    with direct.open(request, timeout=5) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


with tempfile.TemporaryDirectory(prefix='Momo 中文 history # ') as directory:
    root = Path(directory)
    config = {
        'mixed-port': proxy, 'external-controller': f'127.0.0.1:{control}',
        'secret': 'acceptance-secret', 'mode': 'rule', 'log-level': 'info',
        'find-process-mode': 'off', 'geoip-mode': False,
        'proxies': [{'name': 'ci-http', 'type': 'http', 'server': '127.0.0.1',
                     'port': origin.server_port}],
        'rules': ['IP-CIDR,198.19.0.1/32,ci-http,no-resolve', 'MATCH,DIRECT'],
        'traffic-history': {'enable': True, 'path': '流量 history #.db',
                            'sample-interval': '1s', 'flush-interval': '100ms',
                            'geoip': {'enable': False}},
        'tun': {'enable': False, 'device': 'Momo CI TUN', 'stack': 'mixed',
                'auto-route': True, 'auto-detect-interface': True,
                'route-address': ['198.18.0.0/15'],
                'dns-hijack': []},
    }
    (root / 'config.yaml').write_text(json.dumps(config), encoding='utf-8')
    if args.tun:
        assert os.name == 'nt', '--tun requires a disposable native Windows runner'
        assert not adapters(), 'Reserved acceptance TUN already exists'
    previous_download = 0
    for cycle in range(2):
        log = root / f'core-{cycle}.log'
        with log.open('wb') as output:
            process = subprocess.Popen([str(binary), '-d', str(root)], stdout=output, stderr=output,
                                       creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0)
            try:
                wait_for(lambda: api('/traffic-history/status').get('ready'))
                # A raw HTTP proxy request prevents urllib's implicit localhost bypass.
                with socket.create_connection(('127.0.0.1', proxy), timeout=10) as stream:
                    stream.sendall((f'GET http://127.0.0.1:{origin.server_port}/ HTTP/1.1\r\n'
                                    f'Host: 127.0.0.1:{origin.server_port}\r\nConnection: close\r\n\r\n').encode())
                    response = b''
                    while chunk := stream.recv(65536):
                        response += chunk
                    assert response.split(b'\r\n\r\n', 1)[1] == payload
                summary = wait_for(lambda: (value if (value := api('/traffic-history/summary')['data'])['download'] >= previous_download + len(payload) else None))
                previous_download = summary['download']
                assert api('/traffic-history/flows')['data']
                if args.tun and cycle == 0:
                    api('/configs', 'PATCH', {'tun': {'enable': True}})
                    wait_for(adapters)
                    assert api('/configs')['tun']['enable']
                    # Ordinary socket -> narrow TUN route -> local mock outbound.
                    with direct.open('http://198.19.0.1/', timeout=30) as response:
                        assert response.status == 200 and response.read() == payload
                    wait_for(lambda: any('tun' in str(row.get('inbound', '')).lower()
                                         for row in api('/traffic-history/flows')['data']))
                    api('/configs', 'PATCH', {'tun': {'enable': False}})
                    wait_for(lambda: not adapters())
            except BaseException:
                print(log.read_text(encoding='utf-8', errors='replace'))
                raise
            finally:
                if process.poll() is None:
                    process.send_signal(signal.CTRL_BREAK_EVENT if os.name == 'nt' else signal.SIGTERM)
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                        raise AssertionError('Core did not shut down gracefully')
            assert process.returncode == 0, log.read_text(encoding='utf-8', errors='replace')
        if args.tun:
            wait_for(lambda: not adapters())
    assert (root / '流量 history #.db').is_file()
origin.shutdown()
print('Native proxy, history persistence and clean shutdown passed' + ('; TUN communication/cleanup passed' if args.tun else ''))
