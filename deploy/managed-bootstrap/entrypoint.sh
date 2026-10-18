#!/bin/sh
set -eu
# Refuse Node preloads before starting Node, rather than after they can run.
if [ -n "${NODE_OPTIONS-}${NODE_PATH-}${NODE_EXTRA_CA_CERTS-}${LD_PRELOAD-}${LD_LIBRARY_PATH-}" ]; then
  echo 'Managed identity bootstrap refused' >&2
  exit 1
fi
exec "$@"
