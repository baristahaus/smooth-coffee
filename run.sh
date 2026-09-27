#!/bin/sh
# http://127.0.0.1 is a secure context, so getUserMedia works without a certificate.
set -eu
port="${1:-8765}"
exec python3 "$(dirname "$0")/devserver.py" "$port"
