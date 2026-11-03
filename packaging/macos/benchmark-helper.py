"""Measure helper CPU and RSS on a disposable macOS CI runner, never a user Mac."""
import argparse
import http.client
import json
import os
from pathlib import Path
import re
import socket
import statistics
import subprocess
import time

LABEL = 'world.fansionia.clash-momo.helper'
SOCKET = '/Library/PrivilegedHelperTools/world.fansionia.clash-momo.ipc/helper.sock'


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)


def request(endpoint, body=None, token=None):
    connection = UnixHTTP('localhost', timeout=5)
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['X-Momo-Session'] = token
    try:
        connection.request('POST' if body is not None else 'GET', endpoint,
                           json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        data = response.read()
        assert response.status == 200, (endpoint, response.status)
        return json.loads(data)
    finally:
        connection.close()


def usage(pid):
    output = subprocess.check_output(
        ['/bin/ps', '-p', str(pid), '-o', 'time=', '-o', 'rss='], text=True).strip()
    cpu, rss = output.split()
    parts = cpu.split(':')
    seconds = float(parts[-1]) + int(parts[-2]) * 60
    if len(parts) > 2:
        seconds += int(parts[-3]) * 3600
    return seconds, int(rss)


def measure(pid, token=None):
    start_cpu, _ = usage(pid)
    start = time.monotonic()
    next_lease = start
    rss = []
    latencies = []
    while time.monotonic() - start < 12:
        if token and time.monotonic() >= next_lease:
            before = time.monotonic()
            request('/v1/lease', {}, token)
            latencies.append((time.monotonic() - before) * 1000)
            next_lease += 2
        rss.append(usage(pid)[1])
        time.sleep(.25)
    elapsed = time.monotonic() - start
    cpu, _ = usage(pid)
    return {'duration_seconds': elapsed, 'cpu_seconds': cpu - start_cpu,
            'cpu_percent_one_core': 100 * (cpu - start_cpu) / elapsed,
            'rss_median_kib': statistics.median(rss), 'rss_peak_kib': max(rss),
            'lease_latency_ms': latencies}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('implementation', choices=['go', 'rust'])
    parser.add_argument('output')
    args = parser.parse_args()
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable CI only'
    assert os.uname().sysname == 'Darwin'
    status = request('/v1/status')
    assert not status['running'], 'Benchmark requires an idle helper'
    launch = subprocess.check_output(
        ['sudo', '/bin/launchctl', 'print', 'system/' + LABEL], text=True)
    match = re.search(r'^\s*pid = ([0-9]+)$', launch, re.M)
    assert match, 'Could not identify the installed helper PID'
    pid = int(match[1])
    idle = measure(pid)
    token = request('/v1/session', {})['token']
    leased = measure(pid, token)
    result = {'implementation': args.implementation, 'pid': pid, 'idle': idle, 'leased': leased,
              'scope': 'Helper only, without a running core; sampled RSS, not lifetime peak RSS.'}
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    time.sleep(11)


if __name__ == '__main__':
    main()
