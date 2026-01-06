#!/bin/sh

if wget -q --spider --timeout=20 http://127.0.0.1:26657/status; then
  echo "HEALTHY"
  exit 0
else
  echo "UNHEALTHY"
  exit 1
fi
