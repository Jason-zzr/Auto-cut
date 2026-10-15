#!/bin/sh
set -eu
resources="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"
unset NODE_OPTIONS NODE_PATH
exec "$resources/runtime/node" "$resources/host.cjs"
