#!/usr/bin/env python3
"""Dev server for the visualiser: localhost is a secure context, so getUserMedia
works without a certificate, and no-store means an edit is always the code that
runs next reload."""

import functools
import http.server
import os
import sys


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("    %s\n" % (fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoStoreHandler, directory=".")
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"smooth coffee  ->  http://127.0.0.1:{port}/", flush=True)
        httpd.serve_forever()
