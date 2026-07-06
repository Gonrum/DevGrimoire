#!/usr/bin/env bash
# Balancer chat-path E2E (DO NOT RUN in CI without a live stack).
#
# Requires: running backend on :3200 with $DEVGRIMOIRE_API_KEY, chat enabled,
# and at least one project. Starts a tiny mock OpenAI-compatible SSE server on
# :19998 and registers it as a `chat` endpoint, then drives a real chat request
# through POST /api/chat/sessions/:id/message and asserts the SSE stream carries
# tokens (i.e. the request went queue → worker → LlmClient → relay → controller).
#
# The mock host defaults to host.docker.internal (backend runs in docker, mock
# on the host — same convention as balancer-embed.sh). Override with MOCK_HOST.
set -euo pipefail
BASE="${BASE:-http://localhost:3200}"
KEY="${DEVGRIMOIRE_API_KEY:?set DEVGRIMOIRE_API_KEY}"
MOCK_HOST="${MOCK_HOST:-host.docker.internal}"
MOCK_PORT="${MOCK_PORT:-19998}"

# Mock OpenAI-compatible server: /v1/models (probe) + /v1/chat/completions (SSE).
node -e '
const http=require("http");
const PORT=parseInt(process.env.MOCK_PORT||"19998",10);
http.createServer((req,res)=>{
  if (req.url && req.url.startsWith("/v1/models")) {
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({data:[{id:"mock-chat"}]}));
    return;
  }
  if (req.url==="/v1/chat/completions") {
    let b="";req.on("data",d=>b+=d);req.on("end",()=>{
      res.setHeader("content-type","text/event-stream");
      const chunk=(c)=>res.write("data: "+JSON.stringify({choices:[{delta:{content:c}}]})+"\n\n");
      chunk("Hello");
      chunk(" from");
      chunk(" the balancer");
      res.write("data: "+JSON.stringify({choices:[{delta:{},finish_reason:"stop"}]})+"\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.statusCode=404;res.end();
}).listen(PORT,()=>console.error("mock chat up on "+PORT));
' &
MOCK=$!; trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 1

# Register a chat endpoint pointing at the mock.
EP_ID=$(curl -s -X POST "$BASE/api/llm-endpoints" -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d "{\"label\":\"mock-chat\",\"provider\":\"openai-compatible\",\"baseUrl\":\"http://$MOCK_HOST:$MOCK_PORT\",\"model\":\"mock-chat\",\"purposes\":[\"chat\"],\"concurrency\":2}" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
echo "endpoint=$EP_ID"

# Pick a project (first one) to scope the chat session.
PROJECT_ID="${PROJECT_ID:-$(curl -s "$BASE/api/projects" -H "Authorization: Bearer $KEY" \
  | node -e 'process.stdin.on("data",d=>{const a=JSON.parse(d);const p=Array.isArray(a)?a:(a.items||a.data||[]);console.log(p[0]&&(p[0].id||p[0]._id)||"")})')}"
[ -n "$PROJECT_ID" ] || { echo "FAIL: no project available (set PROJECT_ID)"; exit 1; }
echo "project=$PROJECT_ID"

# Create a chat session.
SESSION_ID=$(curl -s -X POST "$BASE/api/chat/sessions" -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"title\":\"balancer-chat-e2e\"}" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id||JSON.parse(d)._id))')
[ -n "$SESSION_ID" ] || { echo "FAIL: session not created"; exit 1; }
echo "session=$SESSION_ID"

# Drive a streaming chat request; capture the SSE body.
OUT=$(curl -s -N -X POST "$BASE/api/chat/sessions/$SESSION_ID/message" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"content":"say hello"}')
echo "--- SSE body ---"
echo "$OUT" | head -40
echo "----------------"

echo "$OUT" | grep -q '"type":"token"' || { echo "FAIL: no token event in SSE stream"; exit 1; }
echo "$OUT" | grep -q '"type":"error"' && { echo "FAIL: error event present"; exit 1; }

# Cleanup.
curl -s -X DELETE "$BASE/api/chat/sessions/$SESSION_ID" -H "Authorization: Bearer $KEY" >/dev/null || true
curl -s -X DELETE "$BASE/api/llm-endpoints/$EP_ID" -H "Authorization: Bearer $KEY" >/dev/null || true
echo "balancer-chat OK"
