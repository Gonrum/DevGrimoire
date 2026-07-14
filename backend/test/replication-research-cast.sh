#!/usr/bin/env bash
# E2E: apply-side ObjectId cast for research entities on /sync/receive.
# ResearchTopic nests its opt-in refs under scope.projectIds/scope.customerIds;
# ResearchArtifact has top-level topicId/lastRunId ObjectId refs (topicId is part
# of a UNIQUE index). A received upsert must store these as ObjectId, not the raw
# strings they arrive as over JSON — otherwise indexes/queries on them break.
# Requires the dev stack running with the cast fix (backend :3200, auth on).
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

PEN="000000000000000000000301"    # enabled project
TOPIC="000000000000000000000310"  # research topic (multi-project via scope.projectIds)
ART="000000000000000000000311"    # research artifact (single-project, topicId/lastRunId refs)
TREF="000000000000000000000312"   # topicId ref
RREF="000000000000000000000313"   # lastRunId ref

cleanup() {
  set +e
  $MONGO "db.projects.deleteOne({_id:ObjectId('$PEN')});
          db.researchtopics.deleteOne({_id:ObjectId('$TOPIC')});
          db.researchartifacts.deleteOne({_id:ObjectId('$ART')});
          db.replication_applied.deleteMany({appliedKey:{\$in:[/researchtopics:$TOPIC:/,/researchartifacts:$ART:/]}})" >/dev/null
}
trap cleanup EXIT

$MONGO "db.projects.updateOne({_id:ObjectId('$PEN')},{\$set:{name:'cast-e2e',replicationConfig:{enabled:true},updatedAt:new Date()}},{upsert:true});
        db.researchtopics.deleteOne({_id:ObjectId('$TOPIC')});
        db.researchartifacts.deleteOne({_id:ObjectId('$ART')})" >/dev/null

UMS=$(python3 -c "import time;print(int(time.time()*1000))")
ISO=$(python3 -c "import datetime;print(datetime.datetime.utcfromtimestamp($UMS/1000).isoformat()+'Z')")

echo "== 1. ResearchTopic upsert casts nested scope.projectIds to ObjectId =="
BODY_T=$(cat <<JSON
{"sourceInstanceId":"REMOTE-PEER","entries":[{"seq":801,"eventId":"rt:$TOPIC:1","op":"upsert","collection":"researchtopics","documentId":"$TOPIC","projectId":null,"projectIds":["$PEN"],"document":{"_id":"$TOPIC","title":"cast topic","scope":{"mode":"selected","projectIds":["$PEN"],"customerIds":[],"includeGlobal":false},"updatedAt":"$ISO"},"updatedAtMs":$UMS,"deletedAtMs":null,"originInstanceId":"REMOTE-PEER"}]}
JSON
)
R1=$(eval curl -s -X POST "$BASE/api/replication/sync/receive" $AUTH -H "'Content-Type: application/json'" -d "'$BODY_T'")
echo "  $R1"
echo "$R1" | grep -q '"appliedThrough":801' || { echo "FAIL: topic appliedThrough!=801"; exit 1; }
TOK=$($MONGO "var d=db.researchtopics.findOne({_id:ObjectId('$TOPIC')}); print(d && d.scope && d.scope.projectIds && d.scope.projectIds[0] instanceof ObjectId)" | tr -d '\r')
[ "$TOK" = "true" ] || { echo "FAIL: scope.projectIds[0] not cast to ObjectId (got $TOK)"; exit 1; }
echo "PASS"

echo "== 2. ResearchArtifact upsert casts topicId + lastRunId (+ existing projectId) to ObjectId =="
BODY_A=$(cat <<JSON
{"sourceInstanceId":"REMOTE-PEER","entries":[{"seq":802,"eventId":"ra:$ART:1","op":"upsert","collection":"researchartifacts","documentId":"$ART","projectId":"$PEN","projectIds":null,"document":{"_id":"$ART","topicId":"$TREF","slug":"cast-art","title":"cast artifact","content":"x","projectId":"$PEN","lastRunId":"$RREF","updatedAt":"$ISO"},"updatedAtMs":$UMS,"deletedAtMs":null,"originInstanceId":"REMOTE-PEER"}]}
JSON
)
R2=$(eval curl -s -X POST "$BASE/api/replication/sync/receive" $AUTH -H "'Content-Type: application/json'" -d "'$BODY_A'")
echo "  $R2"
echo "$R2" | grep -q '"appliedThrough":802' || { echo "FAIL: artifact appliedThrough!=802"; exit 1; }
AOK=$($MONGO "var d=db.researchartifacts.findOne({_id:ObjectId('$ART')}); print(d && (d.topicId instanceof ObjectId) && (d.lastRunId instanceof ObjectId) && (d.projectId instanceof ObjectId))" | tr -d '\r')
[ "$AOK" = "true" ] || { echo "FAIL: artifact topicId/lastRunId/projectId not all cast to ObjectId (got $AOK)"; exit 1; }
echo "PASS"

echo ""
echo "ALL PASS"
