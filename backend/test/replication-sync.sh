#!/usr/bin/env bash
# E2E (single instance): the sync apply path + receive/pull endpoints.
# Requires the dev stack running (backend on :3200, auth enabled).
set -euo pipefail

# Dev backend (direct). NOT :3000 — that is a SEPARATE instance.
BASE="${BASE:-http://localhost:3200}"
ENV_FILE="${ENV_FILE:-.env}"
MONGO_USER=$(grep -E '^MONGO_USER=' "$ENV_FILE" | cut -d= -f2-)
MONGO_PASS=$(grep -E '^MONGO_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
MONGO_DB=$(grep -E '^MONGO_DB=' "$ENV_FILE" | cut -d= -f2-)
API_KEY=$(grep -E '^DEVGRIMOIRE_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$MONGO_USER" ] && [ -n "$MONGO_PASS" ] && [ -n "$MONGO_DB" ] || { echo "FAIL: mongo creds missing in $ENV_FILE"; exit 1; }
[ -n "$API_KEY" ] || { echo "FAIL: DEVGRIMOIRE_API_KEY missing in $ENV_FILE"; exit 1; }
# Auth is enabled — every curl carries the Bearer header via $AUTH.
AUTH="-H \"Authorization: Bearer $API_KEY\""
MONGO="docker compose exec -T mongodb mongosh -u $MONGO_USER -p $MONGO_PASS --authenticationDatabase admin $MONGO_DB --quiet --eval"

# A real, replication-enabled project is required for opt-in to pass. Create one.
PID="000000000000000000000c01"
$MONGO "db.projects.updateOne({_id:ObjectId('$PID')},{\$set:{name:'sync-e2e', replicationConfig:{enabled:true}, updatedAt:new Date()}},{upsert:true})" >/dev/null

echo "== 1. POST /sync/receive applies an upsert entry + writes replication_applied =="
TID="000000000000000000000c02"
UMS=$(python3 -c "import time;print(int(time.time()*1000))")
$MONGO "db.todos.deleteOne({_id:ObjectId('$TID')}); db.replication_applied.deleteMany({appliedKey:/:$TID:/})" >/dev/null
BODY=$(cat <<JSON
{"sourceInstanceId":"REMOTE-PEER","entries":[{"seq":101,"eventId":"e:$TID:1","op":"upsert","collection":"todos","documentId":"$TID","projectId":"$PID","document":{"_id":"$TID","projectId":"$PID","title":"from-peer","updatedAt":"$(python3 -c "import datetime;print(datetime.datetime.utcfromtimestamp($UMS/1000).isoformat()+'Z')")"},"updatedAtMs":$UMS,"deletedAtMs":null,"originInstanceId":"REMOTE-PEER"}]}
JSON
)
RESP=$(eval curl -s -X POST "$BASE/api/replication/sync/receive" $AUTH -H "'Content-Type: application/json'" -d "'$BODY'")
echo "receive resp: $RESP"
echo "$RESP" | grep -q '"appliedThrough":101' || { echo "FAIL: appliedThrough!=101"; exit 1; }
APPLIED=$($MONGO "db.todos.countDocuments({_id:ObjectId('$TID'), title:'from-peer'})" | tr -d '\r')
[ "$APPLIED" = "1" ] || { echo "FAIL: todo not upserted by receive"; exit 1; }
TAG=$($MONGO "db.replication_applied.countDocuments({appliedKey:'todos:$TID:$UMS', originInstanceId:'REMOTE-PEER'})" | tr -d '\r')
[ "$TAG" = "1" ] || { echo "FAIL: replication_applied record not written"; exit 1; }
echo "PASS"

echo "== 2. LWW: a stale (older updatedAtMs) re-apply is skipped =="
OLD=$((UMS - 100000))
BODY2=$(cat <<JSON
{"sourceInstanceId":"REMOTE-PEER","entries":[{"seq":102,"eventId":"e:$TID:2","op":"upsert","collection":"todos","documentId":"$TID","projectId":"$PID","document":{"_id":"$TID","projectId":"$PID","title":"stale","updatedAt":"$(python3 -c "import datetime;print(datetime.datetime.utcfromtimestamp($OLD/1000).isoformat()+'Z')")"},"updatedAtMs":$OLD,"deletedAtMs":null,"originInstanceId":"REMOTE-PEER"}]}
JSON
)
RESP2=$(eval curl -s -X POST "$BASE/api/replication/sync/receive" $AUTH -H "'Content-Type: application/json'" -d "'$BODY2'")
echo "$RESP2" | grep -qi 'LWW' || { echo "FAIL: stale entry not LWW-skipped (resp: $RESP2)"; exit 1; }
STILL=$($MONGO "db.todos.countDocuments({_id:ObjectId('$TID'), title:'from-peer'})" | tr -d '\r')
[ "$STILL" = "1" ] || { echo "FAIL: stale entry overwrote newer local doc"; exit 1; }
echo "PASS"

echo "== 3. opt-in: entry for a non-enabled project is skipped =="
$MONGO "db.projects.updateOne({_id:ObjectId('$PID')},{\$set:{'replicationConfig.enabled':false}})" >/dev/null
TID3="000000000000000000000c03"
BODY3=$(cat <<JSON
{"sourceInstanceId":"REMOTE-PEER","entries":[{"seq":103,"eventId":"e:$TID3:1","op":"upsert","collection":"todos","documentId":"$TID3","projectId":"$PID","document":{"_id":"$TID3","projectId":"$PID","title":"blocked","updatedAt":"2031-01-01T00:00:00Z"},"updatedAtMs":1924992000000,"deletedAtMs":null,"originInstanceId":"REMOTE-PEER"}]}
JSON
)
eval curl -s -X POST "$BASE/api/replication/sync/receive" $AUTH -H "'Content-Type: application/json'" -d "'$BODY3'" >/dev/null
BLOCKED=$($MONGO "db.todos.countDocuments({_id:ObjectId('$TID3')})" | tr -d '\r')
[ "$BLOCKED" = "0" ] || { echo "FAIL: entry applied for non-enabled project"; exit 1; }
$MONGO "db.projects.updateOne({_id:ObjectId('$PID')},{\$set:{'replicationConfig.enabled':true}})" >/dev/null
echo "PASS"

echo "== 4. GET /sync/pull serves only origin==self entries with nextSince =="
# The local log already contains an origin=self entry from the upsert in step 1
# (the change stream tagged it origin=REMOTE-PEER via replication_applied, so it
# is NOT served). Create a genuine local write to get an origin=self log entry.
TID4="000000000000000000000c04"
# Anchor `since` to just before the local write so pull only needs one small page
# even on a busy dev DB with thousands of existing log entries.
SINCE_BASE=$($MONGO "const r=db.replication_log.find().sort({seq:-1}).limit(1).toArray(); print(r.length?r[0].seq:0)" | tr -d '\r')
$MONGO "db.todos.insertOne({_id:ObjectId('$TID4'), projectId:ObjectId('$PID'), title:'local-write', updatedAt:new Date()})" >/dev/null
sleep 2
PULL=$(eval curl -s '"'"$BASE/api/replication/sync/pull?since=$SINCE_BASE&limit=500"'"' $AUTH)
echo "pull nextSince/hasMore: $(echo "$PULL" | python3 -c "import sys,json;d=json.load(sys.stdin);print('nextSince=%s hasMore=%s entries=%s'%(d['nextSince'],d['hasMore'],len(d['entries'])))")"
SELF=$($MONGO "db.settings.findOne({key:'replication.instanceId'})?.value" | tr -d '\r')
# Every served entry must be origin==self; the REMOTE-PEER-applied entry must NOT appear.
echo "$PULL" | python3 -c "import sys,json;d=json.load(sys.stdin);assert all(e['originInstanceId']=='$SELF' for e in d['entries']),'served a non-self entry';assert any(e['documentId']=='$TID4' for e in d['entries']),'local write not served';assert not any(e['documentId']=='$TID' for e in d['entries']),'peer-applied entry leaked into pull';print('PASS')"

echo "== cleanup =="
$MONGO "db.todos.deleteMany({_id:{\$in:[ObjectId('$TID'),ObjectId('$TID3'),ObjectId('$TID4')]}}); db.projects.deleteOne({_id:ObjectId('$PID')}); db.replication_log.deleteMany({documentId:{\$in:['$TID','$TID4']}}); db.replication_applied.deleteMany({appliedKey:/:(c0|0000)/})" >/dev/null || true
echo "ALL PASS"
