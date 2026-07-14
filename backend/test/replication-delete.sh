#!/usr/bin/env bash
# E2E: delete replication via change-stream pre-images.
# (1) pre-images are enabled on watched collections;
# (2) a DELETE produces a replication_log entry carrying projectId (single) /
#     projectIds (multi) — the core fix (was null before → filtered out);
# (3) the receiver applies a delete via /sync/receive and honours LWW.
# Requires the dev stack running with the Plan-2d code (backend :3200, auth on).
#
# NOTE on scenario 3: the brief for this task referenced the legacy
# `ResearchSession` model / `researchsessions` collection as the multi-project
# example. That module was removed in commit 83f3e73 ("refactor(research):
# remove legacy research-sessions module") and replaced by `ResearchTopic`
# (collection `researchtopics`), which is the current `multiProject: true`
# entry in replication-collections.ts. ResearchTopic nests its opt-in project
# list under `scope.projectIds[]` (not a top-level `projectIds[]`) — see
# replication-log-writer.service.ts's extractProjectRefs(). Scenario 3 below
# targets `researchtopics`/`scope.projectIds` instead, with the identical
# assertion strength (log entry's flat `projectIds` must contain PID).
set -euo pipefail

BASE="${BASE:-http://localhost:3200}"
ENV_FILE="${ENV_FILE:-.env}"
MONGO_USER=$(grep -E '^MONGO_USER=' "$ENV_FILE" | cut -d= -f2-)
MONGO_PASS=$(grep -E '^MONGO_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
MONGO_DB=$(grep -E '^MONGO_DB=' "$ENV_FILE" | cut -d= -f2-)
API_KEY=$(grep -E '^DEVGRIMOIRE_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$MONGO_USER" ] && [ -n "$MONGO_PASS" ] && [ -n "$MONGO_DB" ] || { echo "FAIL: mongo creds missing"; exit 1; }
[ -n "$API_KEY" ] || { echo "FAIL: DEVGRIMOIRE_API_KEY missing"; exit 1; }
AUTH="-H \"Authorization: Bearer $API_KEY\""
MONGO="docker compose exec -T mongodb mongosh -u $MONGO_USER -p $MONGO_PASS --authenticationDatabase admin $MONGO_DB --quiet --eval"

PID="000000000000000000000201"      # enabled project
TID="000000000000000000000210"      # todo (single-project delete)
RS="000000000000000000000211"       # research topic (multi-project delete)
TID2="000000000000000000000212"     # todo for the receive-side delete
poll() { # poll <mongo-count-expr> — succeeds when it prints 1 within ~10s
  for _ in $(seq 1 20); do
    R=$($MONGO "$1" | tr -d '\r')
    [ "$R" = "1" ] && return 0
    sleep 0.5
  done
  return 1
}

cleanup() {
  set +e
  $MONGO "db.projects.deleteOne({_id:ObjectId('$PID')});
          db.todos.deleteMany({_id:{\$in:[ObjectId('$TID'),ObjectId('$TID2')]}});
          db.researchtopics.deleteOne({_id:ObjectId('$RS')});
          db.replication_log.deleteMany({documentId:{\$in:['$TID','$RS','$TID2','$PID']}})" >/dev/null
}
trap cleanup EXIT

$MONGO "db.projects.updateOne({_id:ObjectId('$PID')},{\$set:{name:'del-e2e',replicationConfig:{enabled:true},updatedAt:new Date()}},{upsert:true})" >/dev/null

echo "== 1. Pre-images enabled on todos (startup migration ran) =="
PIMG=$($MONGO "var r=db.runCommand({listCollections:1,filter:{name:'todos'}}); var o=r.cursor.firstBatch[0].options; print(o.changeStreamPreAndPostImages && o.changeStreamPreAndPostImages.enabled === true)" | tr -d '\r')
[ "$PIMG" = "true" ] || { echo "FAIL: pre-images not enabled on todos (rebuild backend with Plan-2d code)"; exit 1; }
echo "PASS"

echo "== 2. A single-project DELETE produces a log entry carrying projectId =="
$MONGO "db.replication_log.deleteMany({documentId:'$TID'});
        db.todos.updateOne({_id:ObjectId('$TID')},{\$set:{projectId:ObjectId('$PID'),title:'del-me',updatedAt:new Date()}},{upsert:true})" >/dev/null
# wait until the writer logged the upsert (writer is live), then delete
poll "db.replication_log.countDocuments({documentId:'$TID',op:'upsert'})>0?1:0" || { echo "FAIL: writer did not log the todo upsert"; exit 1; }
$MONGO "db.todos.deleteOne({_id:ObjectId('$TID')})" >/dev/null
poll "db.replication_log.countDocuments({documentId:'$TID',op:'delete'})>0?1:0" || { echo "FAIL: writer did not log the todo delete"; exit 1; }
DPID=$($MONGO "var d=db.replication_log.findOne({documentId:'$TID',op:'delete'}); print(d?d.projectId:'MISSING')" | tr -d '\r')
[ "$DPID" = "$PID" ] || { echo "FAIL: delete log entry projectId=$DPID, expected $PID (pre-image extraction broken)"; exit 1; }
echo "PASS"

echo "== 3. A multi-project (ResearchTopic) DELETE carries projectIds =="
$MONGO "db.replication_log.deleteMany({documentId:'$RS'});
        db.researchtopics.updateOne({_id:ObjectId('$RS')},{\$set:{title:'del-rs',brief:'del-e2e topic',scope:{mode:'selected',projectIds:[ObjectId('$PID')],customerIds:[],includeGlobal:false},updatedAt:new Date()}},{upsert:true})" >/dev/null
poll "db.replication_log.countDocuments({documentId:'$RS',op:'upsert'})>0?1:0" || { echo "FAIL: writer did not log the topic upsert"; exit 1; }
$MONGO "db.researchtopics.deleteOne({_id:ObjectId('$RS')})" >/dev/null
poll "db.replication_log.countDocuments({documentId:'$RS',op:'delete'})>0?1:0" || { echo "FAIL: writer did not log the topic delete"; exit 1; }
RSPIDS=$($MONGO "var d=db.replication_log.findOne({documentId:'$RS',op:'delete'}); print(d && d.projectIds ? d.projectIds.join(',') : 'MISSING')" | tr -d '\r')
echo "$RSPIDS" | grep -q "$PID" || { echo "FAIL: topic delete projectIds='$RSPIDS' missing $PID"; exit 1; }
echo "PASS"

echo "== 4. Receiver applies a delete for an opted-in project's doc =="
$MONGO "db.todos.updateOne({_id:ObjectId('$TID2')},{\$set:{projectId:ObjectId('$PID'),title:'to-delete',updatedAt:new Date(Date.now()-60000)}},{upsert:true})" >/dev/null
DMS=$(python3 -c "import time;print(int(time.time()*1000))")
BODY_DEL=$(cat <<JSON
{"sourceInstanceId":"REMOTE-PEER","entries":[{"seq":701,"eventId":"del:$TID2:1","op":"delete","collection":"todos","documentId":"$TID2","projectId":"$PID","projectIds":null,"document":null,"updatedAtMs":null,"deletedAtMs":$DMS,"originInstanceId":"REMOTE-PEER"}]}
JSON
)
R4=$(eval curl -s -X POST "$BASE/api/replication/sync/receive" $AUTH -H "'Content-Type: application/json'" -d "'$BODY_DEL'")
echo "  $R4"
echo "$R4" | grep -q '"appliedThrough":701' || { echo "FAIL: appliedThrough!=701"; exit 1; }
GONE=$($MONGO "db.todos.countDocuments({_id:ObjectId('$TID2')})" | tr -d '\r')
[ "$GONE" = "0" ] || { echo "FAIL: opted-in delete was not applied (doc still present)"; exit 1; }
echo "PASS"

echo "== 5. LWW: a delete OLDER than the local doc's updatedAt is skipped =="
$MONGO "db.todos.updateOne({_id:ObjectId('$TID2')},{\$set:{projectId:ObjectId('$PID'),title:'fresh',updatedAt:new Date()}},{upsert:true})" >/dev/null
OLD_DMS=$(python3 -c "import time;print(int(time.time()*1000)-120000)")  # 2 min in the past
BODY_STALE=$(cat <<JSON
{"sourceInstanceId":"REMOTE-PEER","entries":[{"seq":702,"eventId":"del:$TID2:2","op":"delete","collection":"todos","documentId":"$TID2","projectId":"$PID","projectIds":null,"document":null,"updatedAtMs":null,"deletedAtMs":$OLD_DMS,"originInstanceId":"REMOTE-PEER"}]}
JSON
)
R5=$(eval curl -s -X POST "$BASE/api/replication/sync/receive" $AUTH -H "'Content-Type: application/json'" -d "'$BODY_STALE'")
echo "  $R5"
# appliedThrough still advances (LWW skip is terminal) but the fresher doc must survive.
echo "$R5" | grep -q '"appliedThrough":702' || { echo "FAIL: appliedThrough!=702 (terminal LWW skip should advance)"; exit 1; }
SURVIVE=$($MONGO "db.todos.countDocuments({_id:ObjectId('$TID2'),title:'fresh'})" | tr -d '\r')
[ "$SURVIVE" = "1" ] || { echo "FAIL: stale delete removed a fresher local doc (LWW broken)"; exit 1; }
echo "PASS"

echo ""
echo "ALL PASS"
