#!/usr/bin/env python3
"""Drive the browser MCP server the way an agent would, and report what happened.

"chromium is installed" and "an agent can see a page" are different claims.
This one starts the MCP server over stdio, does the initialize handshake, lists
its tools, serves a page locally, and navigates to it - which is the path that
actually breaks when a shared library or a sandbox flag is missing.

Usage: browser-probe.py [mcp command ...]      (default: playwright-mcp ...)
Exits non-zero with a reason if any step fails.
"""
from __future__ import annotations

import http.server
import json
import queue
import subprocess
import sys
import threading
import time

PAGE = b"<html><body><h1 id=marker>t3code-browser-probe</h1></body></html>"

DEFAULT_CMD = [
    "playwright-mcp", "--headless", "--isolated", "--no-sandbox",
    "--executable-path", "/usr/bin/chromium",
]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = PAGE if self.path == "/" else b"not found"
        self.send_response(200 if self.path == "/" else 404)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class Client:
    def __init__(self, cmd: list[str]):
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self.lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        assert self.proc.stdout
        for line in self.proc.stdout:
            self.lines.put(line)

    def send(self, payload: dict):
        assert self.proc.stdin
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def await_id(self, request_id: int, timeout: float = 90.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise SystemExit(f"MCP server exited early (code {self.proc.returncode})")
            try:
                line = self.lines.get(timeout=1).strip()
            except queue.Empty:
                continue
            if not line.startswith("{"):
                continue
            message = json.loads(line)
            if message.get("id") == request_id:
                return message
        raise SystemExit(f"timed out waiting for response id={request_id}")


def main() -> int:
    cmd = sys.argv[1:] or DEFAULT_CMD

    # Port 0: let the kernel pick, so the probe cannot collide with whatever
    # the agent happens to be running.
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    client = Client(cmd)
    try:
        client.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "t3code-browser-probe", "version": "1"}}})
        info = client.await_id(1)["result"]["serverInfo"]
        print(f"  server:   {info['name']} {info.get('version', '')}".rstrip())

        client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        client.send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = {t["name"] for t in client.await_id(2)["result"]["tools"]}
        print(f"  tools:    {len(tools)}")

        # playwright-mcp navigates the current tab; chrome-devtools-mcp wants a
        # page to exist first, and `new_page` both creates and navigates one.
        navigate = next((t for t in ("browser_navigate", "new_page") if t in tools), None)
        if navigate is None:
            raise SystemExit(f"no navigation tool among: {sorted(tools)}")

        client.send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": navigate, "arguments": {"url": f"http://127.0.0.1:{port}/"}}})
        result = client.await_id(3)
        payload = json.dumps(result.get("result", result))

        if result.get("result", {}).get("isError") or '"isError": true' in payload:
            raise SystemExit(f"navigation reported an error: {payload[:400]}")
        if f"127.0.0.1:{port}" not in payload:
            raise SystemExit(f"navigation did not reach the page: {payload[:400]}")

        print(f"  navigate: reached http://127.0.0.1:{port}/ via {navigate}")
        return 0
    finally:
        client.proc.terminate()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
