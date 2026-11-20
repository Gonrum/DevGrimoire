#!/usr/bin/env bash
# E2E: Werkstatt-IDE — exercises the REST routes under /api/workspaces/:id/fs
# against the real running stack (backend -> workspace sidecar), not fakes.
#
# It creates its own throwaway project + workspace (random suffix) and a second,
# tool-restricted API key, and removes all three on every exit path.
#
# Usage (key is read from the environment, never printed):
#   set -a; . ./.env; set +a
#   bash backend/test/workspace-ide-e2e.sh
#   API_BASE=http://localhost:3200/api DEVGRIMOIRE_API_KEY=cv_... bash backend/test/workspace-ide-e2e.sh
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3200/api}"
API_KEY="${DEVGRIMOIRE_API_KEY:-}"
SUFFIX="$RANDOM$RANDOM"
FAILS=0
TOTAL=0
PROJECT_ID=""
WS_ID=""
KEY2_ID=""
JAUTH=""
TMPDIR_E2E="$(mktemp -d)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing binary: $1"; exit 2; }; }
need curl; need jq; need sha256sum; need head
[ -n "$API_KEY" ] || { echo "DEVGRIMOIRE_API_KEY not set"; exit 2; }
AUTH="Authorization: Bearer $API_KEY"

CODE=""
BODY=""
# req <auth-header> <curl args...>: sets CODE and BODY (body from a temp file).
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
# expect <label> <condition-exit-status>
check() { if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }

cleanup() {
  set +e
  if [ -n "$WS_ID" ]; then
    # archive first (ignored when already archived), then delete
    curl -s -o /dev/null -X POST -H "$AUTH" "$API_BASE/workspaces/$WS_ID/archive"
    curl -s -o /dev/null -X DELETE -H "$AUTH" "$API_BASE/workspaces/$WS_ID"
  fi
  if [ -n "$KEY2_ID" ]; then
    [ -n "${JAUTH:-}" ] && curl -s -o /dev/null -X DELETE -H "$JAUTH" "$API_BASE/api-keys/$KEY2_ID"
  fi
  [ -n "$PROJECT_ID" ] && curl -s -o /dev/null -X DELETE -H "$AUTH" "$API_BASE/projects/$PROJECT_ID"
  rm -rf "$TMPDIR_E2E"
}
trap cleanup EXIT

echo "== Setup =="
api -X POST "$API_BASE/projects" -d "{\"name\":\"e2e-ide-$SUFFIX\"}"
PROJECT_ID=$(printf '%s' "$BODY" | jq -r '._id // empty')
[ -n "$PROJECT_ID" ] && ok "project created" || { bad "project creation"; exit 1; }

api -X POST "$API_BASE/workspaces" -d "{\"projectId\":\"$PROJECT_ID\",\"name\":\"e2e-ide-$SUFFIX\"}"
WS_ID=$(printf '%s' "$BODY" | jq -r '._id // empty')
[ -n "$WS_ID" ] && ok "workspace created" || { bad "workspace creation"; exit 1; }
FS="$API_BASE/workspaces/$WS_ID/fs"

echo "== 0. fresh workspace =="
api "$FS/tree?path=."
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -r '.entries | length')" = 0 ]; check "GET tree on a fresh workspace -> 200, entries empty" $?

echo "== 1. write new file =="
api -X PUT "$FS/file" -d '{"path":"hello.txt","content":"hallo welt\nzweite zeile needle\n","baseHash":null}'
HASH1=$(printf '%s' "$BODY" | jq -r '.hash // empty')
[ "$CODE" = 200 ] && [ -n "$HASH1" ]; check "PUT file (new, baseHash null) -> 200 + hash" $?

echo "== 2. read back =="
api "$FS/file?path=hello.txt"
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -r .hash)" = "$HASH1" ] \
  && [ "$(printf '%s' "$BODY" | jq -r .content)" = "$(printf 'hallo welt\nzweite zeile needle\n')" ] \
  && [ "$(printf '%s' "$BODY" | jq -r .path)" = "hello.txt" ]; check "GET file -> same hash, content, path" $?

echo "== 3. conflict =="
api -X PUT "$FS/file" -d '{"path":"hello.txt","content":"x","baseHash":"deadbeef"}'
[ "$CODE" = 409 ] && [ "$(printf '%s' "$BODY" | jq -r '.currentHash // empty')" = "$HASH1" ]; check "PUT with wrong baseHash -> 409 + currentHash" $?

echo "== 4. mkdir, move, tree =="
api -X POST "$FS/mkdir" -d '{"path":"sub dir"}'
[ "$CODE" = 200 ]; check "POST mkdir -> 200" $?
api -X POST "$FS/move" -d '{"from":"hello.txt","to":"sub dir/hallo #1.txt"}'
[ "$CODE" = 200 ]; check "POST move (space + #) -> 200" $?
api "$FS/tree?path=sub%20dir"
[ "$CODE" = 200 ] && jqok '.entries | map(select(.name=="hallo #1.txt" and .type=="file")) | length == 1'; check "GET tree shows the moved name" $?
api "$FS/tree"
[ "$CODE" = 200 ] && jqok '.truncated == false and (.entries | map(select(.name=="sub dir" and .type=="dir")) | length == 1) and (.entries | map(select(.name=="hello.txt")) | length == 0)'; check "GET tree root: dir present, old name gone" $?

echo "== 5. upload =="
head -c 1000 /dev/urandom > "$TMPDIR_E2E/blob.bin"
SUM_BLOB=$(sha256sum < "$TMPDIR_E2E/blob.bin")
req "$AUTH" -X POST -H 'Content-Type: application/octet-stream' --data-binary @"$TMPDIR_E2E/blob.bin" "$FS/upload?dir=sub%20dir&fileName=blob.bin"
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -r .path)" = "sub dir/blob.bin" ] && [ "$(printf '%s' "$BODY" | jq -r .size)" = 1000 ]; check "POST upload -> 200 + path + size" $?
req "$AUTH" -X POST -H 'Content-Type: application/octet-stream' --data-binary @"$TMPDIR_E2E/blob.bin" "$FS/upload?dir=sub%20dir&fileName=blob.bin"
[ "$CODE" = 409 ]; check "POST upload again without overwrite -> 409" $?
head -c 500 /dev/urandom > "$TMPDIR_E2E/blob2.bin"
SUM_BLOB2=$(sha256sum < "$TMPDIR_E2E/blob2.bin")
req "$AUTH" -X POST -H 'Content-Type: application/octet-stream' --data-binary @"$TMPDIR_E2E/blob2.bin" "$FS/upload?dir=sub%20dir&fileName=blob.bin&overwrite=1"
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -r .size)" = 500 ]; check "POST upload with overwrite=1 -> 200 + new size" $?
curl -s -H "$AUTH" -o "$TMPDIR_E2E/raw.bin" -w '%{http_code}' "$FS/raw?path=sub%20dir/blob.bin" > "$TMPDIR_E2E/code"
CODE=$(cat "$TMPDIR_E2E/code"); BODY="(binary)"
[ "$CODE" = 200 ] && [ "$(sha256sum < "$TMPDIR_E2E/raw.bin")" = "$SUM_BLOB2" ]; check "GET raw returns exactly the uploaded bytes (sha256)" $?
[ "$SUM_BLOB" != "$SUM_BLOB2" ]; check "overwrite really replaced the content" $?

echo "== 5b. large upload onto existing target without overwrite =="
head -c 16777216 /dev/urandom > "$TMPDIR_E2E/big.bin"
req "$AUTH" -X POST -H 'Content-Type: application/octet-stream' --data-binary @"$TMPDIR_E2E/big.bin" "$FS/upload?dir=sub%20dir&fileName=blob.bin"
[ "$CODE" = 409 ]; check "16 MB upload onto existing target, no overwrite -> 409 (not a connection error)" $?

echo "== 6. search =="
api -X POST "$FS/search" -d '{"query":"needle"}'
[ "$CODE" = 200 ] && jqok '.matches | map(select(.path=="sub dir/hallo #1.txt" and .line==2 and .column==14 and (.text|contains("needle")))) | length == 1'; check "POST search -> match with path/line/column" $?

echo "== 6b. special characters end to end =="
SPECIAL='ordner mit leer/ünï #1?%.txt'
SPECIAL_Q=$(jq -rn --arg p "$SPECIAL" '$p|@uri')
SPECIAL_CONTENT=$'ümläut & #hash ?query %20 ✓\n'
api -X POST "$FS/mkdir" -d '{"path":"ordner mit leer"}'
[ "$CODE" = 200 ]; check "POST mkdir of a directory name with spaces -> 200" $?
api -X PUT "$FS/file" -d "$(jq -nc --arg p "$SPECIAL" --arg c "$SPECIAL_CONTENT" '{path:$p,content:$c,baseHash:null}')"
[ "$CODE" = 200 ]; check "PUT file with special characters in path -> 200" $?
api "$FS/file?path=$SPECIAL_Q"
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -r .path)" = "$SPECIAL" ] \
  && [ "$(printf '%s' "$BODY" | jq -j .content | sha256sum)" = "$(printf '%s' "$SPECIAL_CONTENT" | sha256sum)" ]; check "GET file with special path: path and content round-trip" $?
SPECIAL2='ordner mit leer/zwei ä#2?.txt'
api -X POST "$FS/move" -d "$(jq -nc --arg a "$SPECIAL" --arg b "$SPECIAL2" '{from:$a,to:$b}')"
[ "$CODE" = 200 ]; check "POST move of special-character path -> 200" $?
api "$FS/file?path=$(jq -rn --arg p "$SPECIAL2" '$p|@uri')"
[ "$CODE" = 200 ] && [ "$(printf '%s' "$BODY" | jq -j .content | sha256sum)" = "$(printf '%s' "$SPECIAL_CONTENT" | sha256sum)" ]; check "GET moved special-character file: content intact" $?

echo "== 6c. status =="
api "$FS/status"
[ "$CODE" = 200 ] && jqok '.branch == null'; check "GET status on repo-less workspace -> branch null" $?

echo "== 7. delete =="
api -X POST "$FS/delete" -d '{"path":"sub dir/hallo #1.txt"}'
[ "$CODE" = 204 ]; check "POST delete -> 204" $?
api "$FS/file?path=$(jq -rn --arg p 'sub dir/hallo #1.txt' '$p|@uri')"
[ "$CODE" = 404 ]; check "GET file after delete -> 404" $?

echo "== unknown workspace =="
api "$API_BASE/workspaces/000000000000000000000000/fs/tree"
[ "$CODE" = 404 ]; check "GET tree on unknown workspace id -> 404" $?

echo "== 9. restricted API key =="
# Creating an API key needs a user login (API keys cannot manage API keys), so
# this step needs AUTH_USERNAME/AUTH_PASSWORD of an active account.
JWT=""
if [ -n "${AUTH_USERNAME:-}" ] && [ -n "${AUTH_PASSWORD:-}" ]; then
  JWT=$(curl -s -X POST "$API_BASE/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg u "$AUTH_USERNAME" --arg p "$AUTH_PASSWORD" '{username:$u,password:$p}')" \
    | jq -r '.access_token // .accessToken // empty')
fi
KEY2_SECRET=""
if [ -n "$JWT" ]; then
  JAUTH="Authorization: Bearer $JWT"
  req "$JAUTH" -H 'Content-Type: application/json' -X POST "$API_BASE/api-keys" -d "{\"name\":\"e2e-ide-restricted-$SUFFIX\"}"
  KEY2_ID=$(printf '%s' "$BODY" | jq -r '._id // empty')
  KEY2_SECRET=$(printf '%s' "$BODY" | jq -r '.key // empty')
  if [ -n "$KEY2_ID" ]; then
    req "$JAUTH" -H 'Content-Type: application/json' -X PUT "$API_BASE/api-keys/$KEY2_ID" -d '{"allowedTools":["todo_list"]}'
    [ "$CODE" = 200 ] || KEY2_SECRET=""
  fi
fi
if [ -n "$KEY2_SECRET" ]; then
  ok "second API key created with allowedTools allowlist"
  req "Authorization: Bearer $KEY2_SECRET" "$FS/tree"
  [ "$CODE" = 403 ]; check "GET tree with allowlisted API key -> 403" $?
else
  CODE="-"; BODY="could not create a restricted API key (needs a working JWT login via AUTH_USERNAME/AUTH_PASSWORD)"; bad "second API key creation"
fi

echo "== 8. archived workspace =="
api -X POST "$API_BASE/workspaces/$WS_ID/archive"
[ "$CODE" = 200 ] || [ "$CODE" = 201 ]; check "workspace archived" $?
api "$FS/tree"
[ "$CODE" = 409 ]; check "GET tree on archived workspace -> 409" $?

echo
if [ "$FAILS" -eq 0 ]; then echo "ALLE $TOTAL CHECKS BESTANDEN"; exit 0; else echo "$FAILS von $TOTAL CHECK(S) FEHLGESCHLAGEN"; exit 1; fi
