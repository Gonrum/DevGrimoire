#!/usr/bin/env bash
# E2E (single instance): multi-project opt-in for ResearchSession via /sync/receive.
# Asserts: a session whose projectIds includes ONE enabled project is applied;
# a session whose projects are all NOT enabled is skipped (skipped_optin).
# Requires the dev stack running (backend :3200, auth on).
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

PEN="000000000000000000000f01"   # enabled project
PDIS="000000000000000000000f02"  # disabled project
RS_OK="000000000000000000000f10" # session referencing [PDIS, PEN] → should apply
RS_NO="000000000000000000000f11" # session referencing [PDIS] only → should skip

cleanup() {
  set +e
  $MONGO "db.projects.deleteMany({_id:{\$in:[ObjectId('$PEN'),ObjectId('$PDIS')]}});
          db.researchsessions.deleteMany({_id:{\$in:[ObjectId('$RS_OK'),ObjectId('$RS_NO')]}});
          db.replication_applied.deleteMany({appliedKey:/researchsessions:/})" >/dev/null
}
trap cleanup EXIT

$MONGO "db.projects.updateOne({_id:ObjectId('$PEN')},{\$set:{name:'rs-enabled',replicationConfig:{enabled:true},updatedAt:new Date()}},{upsert:true});
        db.projects.updateOne({_id:ObjectId('$PDIS')},{\$set:{name:'rs-disabled',replicationConfig:{enabled:false},updatedAt:new Date()}},{upsert:true});
        db.researchsessions.deleteMany({_id:{\$in:[ObjectId('$RS_OK'),ObjectId('$RS_NO')]}})" >/dev/null

UMS=$(python3 -c "import time;print(int(time.time()*1000))")
ISO=$(python3 -c "import datetime;print(datetime.datetime.utcfromtimestamp($UMS/1000).isoformat()+'Z')")

echo "== 1. ResearchSession with an ENABLED project in projectIds is applied =="
BODY_OK=$(cat <<JSON
{"sourceInstanceId":"REMOTE-PEER","entries":[{"seq":501,"eventId":"rs:$RS_OK:1","op":"upsert","collection":"researchsessions","documentId":"$RS_OK","projectId":null,"projectIds":["$PDIS","$PEN"],"document":{"_id":"$RS_OK","title":"multi-proj session","projectIds":["$PDIS","$PEN"],"status":"open","updatedAt":"$ISO"},"updatedAtMs":$UMS,"deletedAtMs":null,"originInstanceId":"REMOTE-PEER"}]}
JSON
)
R1=$(eval curl -s -X POST "$BASE/api/replication/sync/receive" $AUTH -H "'Content-Type: application/json'" -d "'$BODY_OK'")
echo "  $R1"
echo "$R1" | grep -q '"appliedThrough":501' || { echo "FAIL: appliedThrough!=501"; exit 1; }
APPLIED=$($MONGO "db.researchsessions.countDocuments({_id:ObjectId('$RS_OK'),title:'multi-proj session'})" | tr -d '\r')
[ "$APPLIED" = "1" ] || { echo "FAIL: enabled-project session not applied"; exit 1; }
# projectIds must be cast back to ObjectId (not left as strings)
OIDOK=$($MONGO "var d=db.researchsessions.findOne({_id:ObjectId('$RS_OK')}); print(d && d.projectIds && d.projectIds[0] instanceof ObjectId)" | tr -d '\r')
[ "$OIDOK" = "true" ] || { echo "FAIL: projectIds not cast to ObjectId"; exit 1; }
echo "PASS"

echo "== 2. ResearchSession with NO enabled project is skipped (not applied) =="
BODY_NO=$(cat <<JSON
{"sourceInstanceId":"REMOTE-PEER","entries":[{"seq":502,"eventId":"rs:$RS_NO:1","op":"upsert","collection":"researchsessions","documentId":"$RS_NO","projectId":null,"projectIds":["$PDIS"],"document":{"_id":"$RS_NO","title":"disabled-only session","projectIds":["$PDIS"],"status":"open","updatedAt":"$ISO"},"updatedAtMs":$UMS,"deletedAtMs":null,"originInstanceId":"REMOTE-PEER"}]}
JSON
)
R2=$(eval curl -s -X POST "$BASE/api/replication/sync/receive" $AUTH -H "'Content-Type: application/json'" -d "'$BODY_NO'")
echo "  $R2"
# appliedThrough still advances (skip is terminal), but the doc must NOT exist.
echo "$R2" | grep -q '"appliedThrough":502' || { echo "FAIL: appliedThrough!=502 (terminal skip should advance)"; exit 1; }
NOAPPLIED=$($MONGO "db.researchsessions.countDocuments({_id:ObjectId('$RS_NO')})" | tr -d '\r')
[ "$NOAPPLIED" = "0" ] || { echo "FAIL: disabled-only session WAS applied (opt-in leak!)"; exit 1; }
echo "PASS"

echo ""
echo "ALL PASS"
