#!/usr/bin/env bash
# Requires: running backend on :3200 with $DEVGRIMOIRE_API_KEY, and a mock
# OpenAI-compatible embeddings server. Starts a tiny node mock on :19999.
set -euo pipefail
BASE="${BASE:-http://localhost:3200}"
KEY="${DEVGRIMOIRE_API_KEY:?set DEVGRIMOIRE_API_KEY}"

node -e '
const http=require("http");
http.createServer((req,res)=>{let b="";req.on("data",d=>b+=d);req.on("end",()=>{
  res.setHeader("content-type","application/json");
  res.end(JSON.stringify({data:[{embedding:[0.1,0.2,0.3]}]}));
});}).listen(19999,()=>console.error("mock up"));
' &
MOCK=$!; trap "kill $MOCK" EXIT
sleep 1

# Register an embedding endpoint pointing at the mock
ID=$(curl -s -X POST "$BASE/api/llm-endpoints" -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"label":"mock-embed","provider":"openai-compatible","baseUrl":"http://host.docker.internal:19999","model":"m","purposes":["embedding"],"concurrency":2}' \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
echo "endpoint=$ID"

# Trigger a rag search (which calls getEmbedding → runEmbed). Expect no 5xx.
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/rag/search?query=hello&projectId=000000000000000000000000" -H "Authorization: Bearer $KEY")
echo "rag search http=$code"
[ "$code" != "500" ] || { echo "FAIL: embed path 500"; exit 1; }

curl -s -X DELETE "$BASE/api/llm-endpoints/$ID" -H "Authorization: Bearer $KEY" >/dev/null
echo "balancer-embed OK"
