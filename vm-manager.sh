#!/bin/sh
# devbox VM Manager launcher for Linux and macOS.
#
# Needs Node.js 18.17+ plus QEMU (qemu-system-x86_64, qemu-img) and the
# OpenSSH client; the manager's first screen lists exactly what is missing
# and how to install it on this system. No root, no npm install.
#
# Arguments are passed through to server.js:
#   --port <n>   --data <dir>   --no-open   --help
# Stop the manager with Ctrl+C; running VMs keep running and are picked up
# again the next time it starts.

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

NODE=$(command -v node 2>/dev/null)
if [ -z "$NODE" ]; then
  for c in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node "$HOME/.volta/bin/node"; do
    if [ -x "$c" ]; then NODE=$c; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "Node.js was not found." >&2
  echo "Install Node.js 18.17 or newer (https://nodejs.org, or: brew install node / sudo apt install nodejs)" >&2
  echo "and run this launcher again." >&2
  exit 1
fi

exec "$NODE" "$DIR/server.js" "$@"
