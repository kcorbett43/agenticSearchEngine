#!/bin/sh
set -e

# Install dependencies if node_modules is missing or empty
if [ ! -d node_modules ] || [ -z "$(ls -A node_modules 2>/dev/null)" ]; then
  npm ci || npm install
fi

exec "$@"


