#!/usr/bin/env bash
# End-to-end for the configurable SSH upload limit + REST streaming upload.
# Requires a running backend and a reachable SSH test connection.
#   BASE=http://localhost:3200/api TOKEN=<admin-jwt> CONN=<sshConnId> REMOTE=/tmp ./ssh-upload-e2e.sh
set -euo pipefail
: "${BASE:?}" "${TOKEN:?}" "${CONN:?}" "${REMOTE:?}"
auth=(-H "Authorization: Bearer $TOKEN")

echo "== set global limit to 1 MB =="
curl -sf "${auth[@]}" -H 'Content-Type: application/json' -X PUT \
  -d '{"maxUploadBytes":1048576}' "$BASE/ssh-config" | grep -q '"maxUploadBytes":1048576'

echo "== small upload (500 KB) should succeed =="
head -c 500000 /dev/urandom > /tmp/dg-small.bin
curl -sf "${auth[@]}" -F "remotePath=$REMOTE/dg-small.bin" -F "file=@/tmp/dg-small.bin" \
  "$BASE/ssh-connections/$CONN/upload" | grep -q '"bytesWritten":500000'

echo "== big upload (2 MB) should be rejected =="
head -c 2000000 /dev/urandom > /tmp/dg-big.bin
code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" \
  -F "remotePath=$REMOTE/dg-big.bin" -F "file=@/tmp/dg-big.bin" \
  "$BASE/ssh-connections/$CONN/upload")
[ "$code" -ge 400 ] || { echo "expected rejection, got $code"; exit 1; }

echo "== raise limit, big upload now succeeds =="
curl -sf "${auth[@]}" -H 'Content-Type: application/json' -X PUT \
  -d '{"maxUploadBytes":52428800}' "$BASE/ssh-config" >/dev/null
curl -sf "${auth[@]}" -F "remotePath=$REMOTE/dg-big.bin" -F "file=@/tmp/dg-big.bin" \
  "$BASE/ssh-connections/$CONN/upload" | grep -q '"bytesWritten":2000000'

echo "ALL OK"
