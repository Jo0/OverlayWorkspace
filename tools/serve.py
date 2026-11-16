#!/usr/bin/env python3
"""Local dev server for OverlayWorkspace.

Serves the repo root on http://127.0.0.1:<port>/ with caching disabled, so
edits show up on reload. Only binds to localhost. The app itself is a static
site and needs no server beyond this (any static host works, e.g. GitHub Pages).

    python tools/serve.py [--port 8765]
"""
import argparse, functools, http.server, os

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript",
                      ".json": "application/json", ".wasm": "application/wasm"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_PUT(self):
        """Dev-only: lets automated tests save exports to samples/out/<name>.
        Only plain file names are accepted; nothing outside samples/out/."""
        prefix = "/samples/out/"
        name = self.path[len(prefix):] if self.path.startswith(prefix) else ""
        if not name or not all(c.isalnum() or c in "._-" for c in name) or name.startswith("."):
            self.send_error(403, "PUT only allowed to /samples/out/<plain file name>")
            return
        out_dir = os.path.join(self.directory, "samples", "out")
        os.makedirs(out_dir, exist_ok=True)
        length = int(self.headers.get("Content-Length", 0))
        with open(os.path.join(out_dir, name), "wb") as f:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        self.send_response(201)
        self.end_headers()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"Serving {root} at http://127.0.0.1:{args.port}/", flush=True)
        httpd.serve_forever()

if __name__ == "__main__":
    main()
