#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null; then
  echo "Install Node.js 24 LTS, then open Join Graphene again."
  read -r -p "Press Enter to close."
  exit 1
fi
node participant/server.js
read -r -p "Press Enter to close."
