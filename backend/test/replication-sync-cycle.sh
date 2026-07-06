#!/usr/bin/env bash
# E2E (single instance, loopback): the sync-driver cycle plumbing, gating,
# cursor advance, and re-run idempotency. The backend container calls its OWN
# internal URL (http://localhost:3000) as the "peer", so a full push+pull HTTP
# round-trip runs against one instance. Self-origin entries are echo-skipped by
# the receiver ("own origin"), which is correct — we assert cursor advancement
# and plumbing here; true cross-instance apply is covered by a 2-instance
# staging test, and the poison/partial/skip cursor correctness by the pure
# unit check (npm run check:replication-sync-cursor).
#
# Requires the dev stack running (backend on :3200, auth enabled).
set -euo pipefail

BASE="${BASE:-http://localhost:3200}"                 # host → container :3000
PEER_INTERNAL="${PEER_INTERNAL:-http://localhost:3000}" # container-internal loopback
ENV_FILE="${ENV_FILE:-.env}"
MONGO_USER=$(grep -E '^MONGO_USER=' "$ENV_FILE" | cut -d= -f2-)
MONGO_PASS=$(grep -E '^MONGO_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
MONGO_DB=$(grep -E '^MONGO_DB=' "$ENV_FILE" | cut -d= -f2-)
API_KEY=$(grep -E '^DEVGRIMOIRE_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$MONGO_USER" ] && [ -n "$MONGO_PASS" ] && [ -n "$MONGO_DB" ] || { echo "FAIL: mongo creds missing in $ENV_FILE"; exit 1; }
[ -n "$API_KEY" ] || { echo "FAIL: DEVGRIMOIRE_API_KEY missing in $ENV_FILE"; exit 1; }
AUTH="-H \"Authorization: Bearer $API_KEY\""
MONGO="docker compose exec -T mongodb mongosh -u $MONGO_USER -p $MONGO_PASS --authenticationDatabase admin $MONGO_DB --quiet --eval"

get_setting() { $MONGO "var d=db.settings.findOne({key:'$1'}); print(d?d.value:'')" | tr -d '\r'; }
set_setting() { $MONGO "db.settings.updateOne({key:'$1'},{\$set:{value:'$2'}},{upsert:true})" >/dev/null; }
del_setting() { $MONGO "db.settings.deleteOne({key:'$1'})" >/dev/null; }

# ── Save prior state for restore ──────────────────────────────────────────────
OLD_DRIVER=$(get_setting 'replication.syncDriver')
OLD_PEER_URL=$(get_setting 'replication.peer.url')
OLD_PEER_KEY=$(get_setting 'replication.peer.apiKey')
OLD_OUT=$(get_setting 'replication.cursor.outbound')
OLD_IN=$(get_setting 'replication.cursor.inbound')

PID="000000000000000000000d01"
EV_PREFIX="cycle-e2e"

cleanup() {
  # Remove synthetic log entries + test project, restore all touched settings.
  $MONGO "db.replication_log.deleteMany({eventId:/^${EV_PREFIX}:/}); db.projects.deleteOne({_id:ObjectId('$PID')})" >/dev/null || true
  restore() { if [ -n "$2" ]; then set_setting "$1" "$2"; else del_setting "$1"; fi; }
  restore 'replication.syncDriver' "$OLD_DRIVER"
  restore 'replication.peer.url' "$OLD_PEER_URL"
  restore 'replication.peer.apiKey' "$OLD_PEER_KEY"
  restore 'replication.cursor.outbound' "$OLD_OUT"
  restore 'replication.cursor.inbound' "$OLD_IN"
}
trap cleanup EXIT

SELF=$(get_setting 'replication.instanceId')
[ -n "$SELF" ] || { echo "FAIL: no replication.instanceId (log writer not seeded?)"; exit 1; }

# ── Seed: opted-in project + a synthetic block ABOVE live traffic ─────────────
$MONGO "db.projects.updateOne({_id:ObjectId('$PID')},{\$set:{name:'cycle-e2e',replicationConfig:{enabled:true},updatedAt:new Date()}},{upsert:true})" >/dev/null
MAXSEQ=$($MONGO "var d=db.replication_log.findOne({},{seq:1},{sort:{seq:-1}}); print(d?d.seq:0)" | tr -d '\r')
BASESEQ=$((MAXSEQ + 1000))
S1=$((BASESEQ + 1)); S2=$((BASESEQ + 2)); S3=$((BASESEQ + 3))
# S1,S2 = self-origin opted-in (in send-set / served by pull). S3 = peer-origin (skipped by both filters).
$MONGO "db.replication_log.deleteMany({eventId:/^${EV_PREFIX}:/});
  db.replication_log.insertMany([
    {seq:$S1,eventId:'${EV_PREFIX}:1',op:'upsert',collection:'todos',documentId:'$PID',projectId:'$PID',document:{_id:'$PID'},updatedAtMs:$S1,deletedAtMs:null,originInstanceId:'$SELF',createdAt:new Date()},
    {seq:$S2,eventId:'${EV_PREFIX}:2',op:'upsert',collection:'todos',documentId:'$PID',projectId:'$PID',document:{_id:'$PID'},updatedAtMs:$S2,deletedAtMs:null,originInstanceId:'$SELF',createdAt:new Date()},
    {seq:$S3,eventId:'${EV_PREFIX}:3',op:'upsert',collection:'todos',documentId:'$PID',projectId:'$PID',document:{_id:'$PID'},updatedAtMs:$S3,deletedAtMs:null,originInstanceId:'PEER-OTHER',createdAt:new Date()}
  ])" >/dev/null

# Pin cursors just below the synthetic block BEFORE activating the driver, so the
# driver starts at our block (not from 0 across the 185k live backlog).
set_setting 'replication.cursor.outbound' "$BASESEQ"
set_setting 'replication.cursor.inbound' "$BASESEQ"
set_setting 'replication.peer.url' "$PEER_INTERNAL"
set_setting 'replication.peer.apiKey' "$API_KEY"

echo "== 1. Gating: driver passive → /sync/now is a no-op, cursors untouched =="
set_setting 'replication.syncDriver' 'passive'
RESP=$(eval curl -s -X POST "$BASE/api/replication/sync/now" $AUTH)
echo "  $RESP"
echo "$RESP" | grep -q '"skippedReason"' || { echo "FAIL: expected skippedReason when passive"; exit 1; }
OUT=$(get_setting 'replication.cursor.outbound')
[ "$OUT" = "$BASESEQ" ] || { echo "FAIL: passive cycle moved outbound cursor ($OUT != $BASESEQ)"; exit 1; }
echo "PASS"

echo "== 2. Active cycle: push+pull round-trip advances both cursors to windowMax =="
set_setting 'replication.syncDriver' 'active'
RESP=$(eval curl -s -X POST "$BASE/api/replication/sync/now" $AUTH)
echo "  $RESP"
OUT=$(get_setting 'replication.cursor.outbound')
IN=$(get_setting 'replication.cursor.inbound')
# Outbound: S1,S2 sent (self-origin opted-in) → receiver echo-skips ('own origin',
# terminal) → appliedThrough=S2 >= maxSent=S2 → advance to windowMax=S3.
[ "$OUT" = "$S3" ] || { echo "FAIL: outbound cursor $OUT != $S3"; exit 1; }
# Inbound: servePull serves S1,S2 (self-origin opted-in); S3 excluded by origin
# filter but counts in nextSince=S3. Applied entries echo-skip (terminal) → all
# handled → inbound advances to nextSince=S3.
[ "$IN" = "$S3" ] || { echo "FAIL: inbound cursor $IN != $S3"; exit 1; }
echo "PASS"

echo "== 3. Idempotency: a second active cycle is a no-op (cursors stay) =="
RESP=$(eval curl -s -X POST "$BASE/api/replication/sync/now" $AUTH)
echo "  $RESP"
OUT2=$(get_setting 'replication.cursor.outbound')
IN2=$(get_setting 'replication.cursor.inbound')
[ "$OUT2" = "$S3" ] || { echo "FAIL: outbound moved on re-run ($OUT2 != $S3)"; exit 1; }
[ "$IN2" = "$S3" ] || { echo "FAIL: inbound moved on re-run ($IN2 != $S3)"; exit 1; }
echo "PASS"

echo "== 4. /sync/status reports cursors + lag =="
ST=$(eval curl -s "$BASE/api/replication/sync/status" $AUTH)
echo "  $ST"
echo "$ST" | grep -q "\"outboundCursor\":$S3" || { echo "FAIL: status outboundCursor != $S3"; exit 1; }
echo "$ST" | grep -q '"localMaxSeq"' || { echo "FAIL: status missing localMaxSeq"; exit 1; }
echo "$ST" | grep -q '"driver":"active"' || { echo "FAIL: status driver != active"; exit 1; }
echo "PASS"

echo ""
echo "ALL PASS"
