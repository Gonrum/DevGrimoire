#!/usr/bin/env bash
# E2E: verify the replication log writer captures writes correctly.
# Requires the dev stack running: docker compose up -d --build backend mongodb
set -euo pipefail

# Credentials are read from .env (run from repo root) — never hardcoded.
ENV_FILE="${ENV_FILE:-.env}"
[[ -f "$ENV_FILE" ]] || { echo "FAIL: no $ENV_FILE found — run from repo root"; exit 1; }
MONGO_USER=$(grep -E '^MONGO_USER=' "$ENV_FILE" | cut -d= -f2-)
MONGO_PASS=$(grep -E '^MONGO_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
MONGO_DB=$(grep -E '^MONGO_DB=' "$ENV_FILE" | cut -d= -f2-)
[[ -n "$MONGO_DB" ]] || { echo "FAIL: MONGO_DB not set in $ENV_FILE"; exit 1; }
MONGO="docker compose exec -T mongodb mongosh -u $MONGO_USER -p $MONGO_PASS --authenticationDatabase admin $MONGO_DB --quiet --eval"

echo "== 1. local write produces an origin=self log entry, monotonic seq =="
TID="000000000000000000000aa1"
$MONGO "db.todos.deleteOne({_id: ObjectId('$TID')})" >/dev/null
$MONGO "db.replication_log.deleteMany({documentId: '$TID'})" >/dev/null
$MONGO "db.todos.insertOne({_id: ObjectId('$TID'), projectId: 'p-e2e', title: 'e2e', updatedAt: new Date()})" >/dev/null
sleep 2
SELF=$($MONGO "db.settings.findOne({key:'replication.instanceId'})?.value" | tr -d '\r')
COUNT=$($MONGO "db.replication_log.countDocuments({documentId: '$TID', op: 'upsert'})" | tr -d '\r')
ORIGIN=$($MONGO "db.replication_log.findOne({documentId: '$TID'})?.originInstanceId" | tr -d '\r')
echo "self=$SELF entries=$COUNT origin=$ORIGIN"
[ "$COUNT" -ge 1 ] || { echo "FAIL: no log entry for local write"; exit 1; }
[ "$ORIGIN" = "$SELF" ] || { echo "FAIL: local write not tagged origin=self"; exit 1; }
echo "PASS"

echo "== 2. seq is monotonic across two writes =="
$MONGO "db.todos.updateOne({_id: ObjectId('$TID')}, {\$set: {title: 'e2e-2', updatedAt: new Date()}})" >/dev/null
sleep 2
SEQS=$($MONGO "db.replication_log.find({documentId: '$TID'}).sort({seq:1}).toArray().map(d=>d.seq).join(',')" | tr -d '\r')
echo "seqs=$SEQS"
python3 -c "s=[int(x) for x in '$SEQS'.split(',') if x]; assert s==sorted(s) and len(set(s))==len(s), 'not strictly increasing'; print('PASS')"

echo "== 3. applied record makes the next write origin=remote =="
$MONGO "db.todos.updateOne({_id: ObjectId('$TID')}, {\$set: {updatedAt: new Date('2030-01-01T00:00:00Z')}})" >/dev/null
UMS=$(python3 -c "import datetime; print(int(datetime.datetime(2030,1,1).timestamp()*1000))")
$MONGO "db.replication_applied.insertOne({appliedKey: 'todos:$TID:$UMS', originInstanceId: 'REMOTE-INSTANCE', createdAt: new Date()})" >/dev/null
$MONGO "db.todos.updateOne({_id: ObjectId('$TID')}, {\$set: {title: 'applied-remotely', updatedAt: new Date($UMS)}})" >/dev/null
sleep 2
RORIGIN=$($MONGO "db.replication_log.find({documentId: '$TID'}).sort({seq:-1}).limit(1).toArray()[0]?.originInstanceId" | tr -d '\r')
echo "latest origin=$RORIGIN"
[ "$RORIGIN" = "REMOTE-INSTANCE" ] || { echo "FAIL: applied-record write not tagged origin=remote"; exit 1; }
echo "PASS"

echo "== 4. delete produces an op=delete entry =="
$MONGO "db.todos.deleteOne({_id: ObjectId('$TID')})" >/dev/null
sleep 2
DEL=$($MONGO "db.replication_log.countDocuments({documentId: '$TID', op: 'delete'})" | tr -d '\r')
[ "$DEL" -ge 1 ] || { echo "FAIL: no delete log entry"; exit 1; }
echo "PASS"

echo "== cleanup =="
$MONGO "db.replication_log.deleteMany({documentId: '$TID'}); db.replication_applied.deleteMany({appliedKey: /:$TID:/})" >/dev/null
echo "ALL PASS"
