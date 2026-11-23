#!/usr/bin/env bash
# E2E: SSH workspaces — exercises /api/workspaces/:id/fs/* against a REAL SSH
# server through an existing SshConnection. Inert unless all three variables are set:
#
#   E2E_SSH_CONNECTION_ID  id of an existing SshConnection
#   E2E_SSH_PROJECT_ID     project that may use this connection
#   E2E_SSH_DIR            absolute, existing directory on the server
#
# Safety: the script only ever writes inside a fresh subfolder
# `dg-e2e-<random>` below E2E_SSH_DIR. It creates it through the IDE routes of a
# workspace on E2E_SSH_DIR and removes only that subfolder again (trap, same
# routes). Workspace entries are deleted afterwards; that never touches the server.
#
# Usage:
#   set -a; . ./.env; set +a
#   E2E_SSH_CONNECTION_ID=... E2E_SSH_PROJECT_ID=... E2E_SSH_DIR=/home/me/scratch \
#     bash backend/test/workspace-ssh-e2e.sh
set -uo pipefail

if [ -z "${E2E_SSH_CONNECTION_ID:-}" ] || [ -z "${E2E_SSH_PROJECT_ID:-}" ] || [ -z "${E2E_SSH_DIR:-}" ]; then
  echo "übersprungen: E2E_SSH_CONNECTION_ID, E2E_SSH_PROJECT_ID und E2E_SSH_DIR müssen gesetzt sein"
  exit 0
fi

API_BASE="${API_BASE:-http://localhost:3200/api}"
API_KEY="${DEVGRIMOIRE_API_KEY:-}"
SUFFIX="$RANDOM$RANDOM"
SUBNAME="dg-e2e-$SUFFIX"
BASE_DIR="${E2E_SSH_DIR%/}"
SUB_DIR="$BASE_DIR/$SUBNAME"
FAILS=0
TOTAL=0
WS_PARENT=""
WS_SUB=""
SUB_CREATED=0
TMPDIR_E2E="$(mktemp -d)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing binary: $1"; exit 2; }; }
need curl; need jq; need sha256sum; need head
[ -n "$API_KEY" ] || { echo "DEVGRIMOIRE_API_KEY not set"; exit 2; }
case "$BASE_DIR" in /?*) ;; *) echo "E2E_SSH_DIR must be an absolute path other than /"; exit 2 ;; esac
AUTH="Authorization: Bearer $API_KEY"

CODE=""
BODY=""
req() {
  local auth="$1"; shift
  CODE=$(curl -s -o "$TMPDIR_E2E/body" -w '%{http_code}' -H "$auth" "$@")
  BODY=$(cat "$TMPDIR_E2E/body" 2>/dev/null)
}
api() { req "$AUTH" -H 'Content-Type: application/json' "$@"; }
jqok() { printf '%s' "$BODY" | jq -e "$1" >/dev/null; }
ok() { TOTAL=$((TOTAL+1)); echo "✓ $1"; }
bad() {
  TOTAL=$((TOTAL+1)); FAILS=$((FAILS+1))
  echo "✗ $1"
  echo "    HTTP $CODE, body: $(printf '%s' "$BODY" | head -c 400)"
}
check() { if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }

cleanup() {
  set +e
  # 1. Remove our own subfolder on the server (only this one), via the parent workspace.
  if [ "$SUB_CREATED" = 1 ] && [ -n "$WS_PARENT" ]; then
    curl -s -o /dev/null -X POST -H "$AUTH" -H 'Content-Type: application/json' \
      "$API_BASE/workspaces/$WS_PARENT/fs/delete" -d "$(jq -nc --arg p "$SUBNAME" '{path:$p}')"
  fi
  # 2. Remove the workspace entries (never touches the server).
  for id in "$WS_SUB" "$WS_PARENT"; do
    [ -n "$id" ] || continue
    curl -s -o /dev/null -X POST -H "$AUTH" "$API_BASE/workspaces/$id/archive"
    curl -s -o /dev/null -X DELETE -H "$AUTH" "$API_BASE/workspaces/$id"
  done
  rm -rf "$TMPDIR_E2E"
}
trap cleanup EXIT

mkws() { # <name> <remotePath>
  api -X POST "$API_BASE/workspaces" -d "$(jq -nc --arg n "$1" --arg p "$E2E_SSH_PROJECT_ID" \
    --arg c "$E2E_SSH_CONNECTION_ID" --arg r "$2" \
    '{projectId:$p,name:$n,location:"ssh",sshConnectionId:$c,remotePath:$r}')"
}

echo "== Setup (nur in $SUB_DIR) =="
mkws "e2e-ssh-parent-$SUFFIX" "$BASE_DIR"
WS_PARENT=$(printf '%s' "$BODY" | jq -r '._id // empty')
[ "$CODE" -lt 300 ] && [ -n "$WS_PARENT" ]; check "workspace on E2E_SSH_DIR created" $?
[ -n "$WS_PARENT" ] || exit 1
PFS="$API_BASE/workspaces/$WS_PARENT/fs"

mkws "e2e-ssh-missing-$SUFFIX" "$BASE_DIR/does-not-exist-$SUFFIX"
MISSING_ID=$(printf '%s' "$BODY" | jq -r '._id // empty')
if [ -n "$MISSING_ID" ]; then
  # Unexpected: the entry exists; remove it so nothing leaks, then report.
  curl -s -o /dev/null -X POST -H "$AUTH" "$API_BASE/workspaces/$MISSING_ID/archive"
  curl -s -o /dev/null -X DELETE -H "$AUTH" "$API_BASE/workspaces/$MISSING_ID"
fi
[ "$CODE" = 400 ]; check "workspace on a non-existent directory -> 400" $?

api -X POST "$PFS/mkdir" -d "$(jq -nc --arg p "$SUBNAME" '{path:$p}')"
[ "$CODE" = 200 ]; check "mkdir $SUBNAME via parent workspace -> 200" $?
[ "$CODE" = 200 ] && SUB_CREATED=1
[ "$SUB_CREATED" = 1 ] || exit 1

mkws "e2e-ssh-$SUFFIX" "$SUB_DIR"
WS_SUB=$(printf '%s' "$BODY" | jq -r '._id // empty')
[ "$CODE" -lt 300 ] && [ -n "$WS_SUB" ] && jqok '.location == "ssh"'; check "workspace on the subfolder created (location ssh)" $?
[ -n "$WS_SUB" ] || exit 1
FS="$API_BASE/workspaces/$WS_SUB/fs"

echo "== 1. tree =="
api "$FS/tree?path=."
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -r '.entries | length')" = 0 ]; check "GET tree of the empty subfolder -> 200, entries empty" $?

echo "== 2. write, read, conflict =="
api -X PUT "$FS/file" -d '{"path":"hello.txt","content":"hallo welt\nzweite zeile needle\n","baseHash":null}'
HASH1=$(printf '%s' "$BODY" | jq -r '.hash // empty')
[ "$CODE" = 200 ] && [ -n "$HASH1" ]; check "PUT file (new) -> 200 + hash" $?
api "$FS/file?path=hello.txt"
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -r .hash)" = "$HASH1" ] \
  && [ "$(printf '%s' "$BODY" | jq -r .content)" = "$(printf 'hallo welt\nzweite zeile needle\n')" ]; check "GET file -> same hash and content" $?
api -X PUT "$FS/file" -d '{"path":"hello.txt","content":"x","baseHash":"deadbeef"}'
[ "$CODE" = 409 ] && [ "$(printf '%s' "$BODY" | jq -r '.currentHash // empty')" = "$HASH1" ]; check "PUT with wrong baseHash -> 409 + currentHash" $?

echo "== 3. mkdir, move, delete =="
api -X POST "$FS/mkdir" -d '{"path":"sub dir"}'
[ "$CODE" = 200 ]; check "POST mkdir -> 200" $?
api -X POST "$FS/move" -d '{"from":"hello.txt","to":"sub dir/hallo #1.txt"}'
[ "$CODE" = 200 ]; check "POST move (space + #) -> 200" $?
api "$FS/tree?path=sub%20dir"
[ "$CODE" = 200 ] && jqok '.entries | map(select(.name=="hallo #1.txt" and .type=="file")) | length == 1'; check "GET tree shows the moved name" $?

echo "== 4. upload =="
head -c 1000 /dev/urandom > "$TMPDIR_E2E/blob.bin"
req "$AUTH" -X POST -H 'Content-Type: application/octet-stream' --data-binary @"$TMPDIR_E2E/blob.bin" "$FS/upload?dir=sub%20dir&fileName=blob.bin"
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -r .size)" = 1000 ]; check "POST upload -> 200 + size" $?
req "$AUTH" -X POST -H 'Content-Type: application/octet-stream' --data-binary @"$TMPDIR_E2E/blob.bin" "$FS/upload?dir=sub%20dir&fileName=blob.bin"
[ "$CODE" = 409 ]; check "POST upload again without overwrite -> 409" $?
head -c 500 /dev/urandom > "$TMPDIR_E2E/blob2.bin"
SUM2=$(sha256sum < "$TMPDIR_E2E/blob2.bin")
req "$AUTH" -X POST -H 'Content-Type: application/octet-stream' --data-binary @"$TMPDIR_E2E/blob2.bin" "$FS/upload?dir=sub%20dir&fileName=blob.bin&overwrite=1"
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -r .size)" = 500 ]; check "POST upload with overwrite=1 -> 200 + new size" $?
CODE=$(curl -s -H "$AUTH" -o "$TMPDIR_E2E/raw.bin" -w '%{http_code}' "$FS/raw?path=sub%20dir/blob.bin"); BODY="(binary)"
[ "$CODE" = 200 ] && [ "$(sha256sum < "$TMPDIR_E2E/raw.bin")" = "$SUM2" ]; check "GET raw returns exactly the uploaded bytes (sha256)" $?

echo "== 5. search =="
api -X POST "$FS/search" -d '{"query":"needle"}'
[ "$CODE" = 200 ] && jqok '.matches | map(select(.path=="sub dir/hallo #1.txt" and .line==2 and (.text|contains("needle")))) | length == 1'; check "POST search -> match with path/line" $?
printf '%s' "$BODY" | jq -r '"    engine: \(.engine // "?")"'
[ "$CODE" = 200 ] && jqok '.engine == "rg" or .engine == "grep"'; check "search reports engine rg or grep" $?

echo "== 6. status =="
api "$FS/status"
[ "$CODE" = 200 ]; check "GET status -> 200" $?

echo "== 7. sidecar tools reject SSH workspaces =="
api -X POST "$API_BASE/workspaces/$WS_SUB/exec/stream" -d '{"command":"echo hi"}'
[ "$CODE" = 409 ]; check "exec on an SSH workspace -> 409" $?

echo "== 8. delete in subfolder =="
api -X POST "$FS/delete" -d '{"path":"sub dir/hallo #1.txt"}'
[ "$CODE" = 204 ]; check "POST delete -> 204" $?
api "$FS/file?path=$(jq -rn --arg p 'sub dir/hallo #1.txt' '$p|@uri')"
[ "$CODE" = 404 ]; check "GET file after delete -> 404" $?

echo "== 9. deleting a workspace entry leaves the server untouched =="
api -X POST "$API_BASE/workspaces/$WS_SUB/archive"
[ "$CODE" = 200 ] || [ "$CODE" = 201 ]; check "workspace archived" $?
api -X DELETE "$API_BASE/workspaces/$WS_SUB"
[ "$CODE" = 204 ]; check "workspace entry deleted -> 204" $?
WS_SUB=""
api "$PFS/tree?path=."
[ "$CODE" = 200 ] && printf '%s' "$BODY" | jq -e --arg n "$SUBNAME" '.entries | map(select(.name==$n and .type=="dir")) | length == 1' >/dev/null; check "subfolder still exists on the server after deleting the workspace entry" $?

echo
if [ "$FAILS" -eq 0 ]; then echo "ALLE $TOTAL CHECKS BESTANDEN"; exit 0; else echo "$FAILS von $TOTAL CHECK(S) FEHLGESCHLAGEN"; exit 1; fi
