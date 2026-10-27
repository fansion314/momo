#!/usr/bin/env python3
"""Run from the repository root after building .cache/mihomo-current (Linux)."""

import json
import os
import pathlib
import signal
import socket
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def read_exact(connection, size):
    result = b""
    while len(result) < size:
        part = connection.recv(size - len(result))
        if not part:
            raise ConnectionError("SOCKS connection closed before ready")
        result += part
    return result


def socks_command(proxy_port, command, target_port=0):
    connection = socket.create_connection(("127.0.0.1", proxy_port), 0.2)
    try:
        connection.settimeout(3)
        connection.sendall(bytes([5, 1, 0]))
        if read_exact(connection, 2) != bytes([5, 0]):
            raise ConnectionError("SOCKS authentication failed")
        connection.sendall(
            bytes([5, command, 0, 1, 127, 0, 0, 1]) + struct.pack("!H", target_port)
        )
        reply = read_exact(connection, 10)
        if reply[:2] != bytes([5, 0]) or reply[3] != 1:
            raise ConnectionError(f"SOCKS command failed: {reply!r}")
        return connection, reply
    except BaseException:
        connection.close()
        raise


def exercise(root, process, proxy_port, api_port):
    def get(path):
        request = urllib.request.Request(
            f"http://127.0.0.1:{api_port}/traffic-history/{path}",
            headers={"Authorization": "Bearer smoke"},
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)

    with socket.socket(type=socket.SOCK_DGRAM) as echo, socket.socket() as probe:
        echo.bind(("127.0.0.1", 0))
        echo.settimeout(15)
        destination_port = echo.getsockname()[1]
        probe.bind(("127.0.0.1", destination_port))
        probe.listen()
        probe.settimeout(15)

        def accept_probe():
            connection, _ = probe.accept()
            connection.close()

        def serve_echo():
            for _ in range(10):
                data, address = echo.recvfrom(4096)
                echo.sendto(data, address)

        threading.Thread(target=accept_probe, daemon=True).start()
        threading.Thread(target=serve_echo, daemon=True).start()

        # A bound listener is visible while Mihomo is still loading its tunnel.
        # Wait for a real proxied connection before asserting UDP delivery.
        for _ in range(100):
            try:
                connection, _ = socks_command(proxy_port, 1, destination_port)
                connection.close()
                break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError((root / "core.log").read_text())

        control, reply = socks_command(proxy_port, 3)
        with control, socket.socket(type=socket.SOCK_DGRAM) as udp:
            relay = ("127.0.0.1", int.from_bytes(reply[8:10], "big"))
            udp.bind(("127.0.0.1", 0))
            udp.settimeout(3)
            header = bytes([0, 0, 0, 1, 127, 0, 0, 1]) + struct.pack("!H", destination_port)
            payload = b"x" * 100
            for _ in range(10):
                udp.sendto(header + payload, relay)
                data, _ = udp.recvfrom(4096)
                assert data[10:] == payload

            time.sleep(2.2)  # Observe at least two periodic sampling opportunities.
            flows = get("flows?network=udp")["data"]
            assert len(flows) == 1, flows
            flow = flows[0]
            assert flow["uploadTotal"] == 1000 and flow["downloadTotal"] == 1000, flow
            assert flow["metadata"]["network"] == "udp", flow

            request = urllib.request.Request(
                f"http://127.0.0.1:{api_port}/connections/{flow['trackerId']}",
                method="DELETE",
                headers={"Authorization": "Bearer smoke"},
            )
            urllib.request.urlopen(request, timeout=3).close()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                flow = get(f"flows/{flow['id']}")["data"]
                if flow["state"] == "closed":
                    break
                time.sleep(0.05)
            assert flow["state"] == "closed", flow

            samples = get(f"flows/{flow['id']}/samples")["data"]
            assert sum(row["upload"] for row in samples) == 1000, samples
            assert sum(row["download"] for row in samples) == 1000, samples
            summary = get("summary?network=udp")["data"]
            assert summary["upload"] == summary["download"] == 1000, summary
            assert summary["connections"] == 1, summary
            groups = get("groups?network=udp&group_by=policy,chain")["data"]
            assert groups[0]["chain"] == ["DIRECT"], groups
            day_start = flow["lastAtMs"] // 86400000 * 86400000
            daily = get(f"summary?resolution=day&interval=1d&network=udp&from={day_start}&to={day_start + 86400000}")["data"]
            assert daily["upload"] == daily["download"] == 1000, daily
            assert daily["connections"] == 1 and daily["participatingConnections"] is None, daily
            print(json.dumps({"udpPayloadUpload": 1000, "udpPayloadDownload": 1000,
                              "state": flow["state"], "summary": summary,
                              "daily": daily, "status": get("status")}))

    process.send_signal(signal.SIGTERM)
    assert process.wait(timeout=7) == 0
    with sqlite3.connect(root / "traffic-history.db") as database:
        totals = database.execute(
            "SELECT SUM(s.upload),SUM(s.download) FROM samples s "
            "JOIN flows f ON f.id=s.flow_id WHERE f.network='udp'"
        ).fetchone()
        assert totals == (1000, 1000), totals
        daily_totals = database.execute("SELECT SUM(upload),SUM(download),SUM(connections) FROM daily_usage WHERE network='udp'").fetchone()
        assert daily_totals == (1000, 1000, 1), daily_totals


def main():
    pathlib.Path(".cache").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="history-udp-", dir=".cache") as directory:
        root = pathlib.Path(directory).resolve()
        proxy_port, api_port = free_port(), free_port()
        (root / "config.yaml").write_text(f"""mixed-port: {proxy_port}
external-controller: 127.0.0.1:{api_port}
secret: smoke
log-level: error
find-process-mode: off
ipv6: false
rules:
  - MATCH,DIRECT
traffic-history:
  enable: true
  aggregation-timezone: UTC
  sample-interval: 1s
  flush-interval: 50ms
  geoip:
    enable: false
""")
        with (root / "core.log").open("w") as log:
            process = subprocess.Popen(
                [str(pathlib.Path(os.environ.get("MIHOMO_HISTORY_BINARY", ".cache/mihomo-current")).resolve()), "-d", str(root)],
                stdout=log, stderr=log,
            )
            try:
                exercise(root, process, proxy_port, api_port)
            except BaseException:
                print((root / "core.log").read_text())
                raise
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=7)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == "__main__":
    main()
