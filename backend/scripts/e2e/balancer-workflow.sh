#!/usr/bin/env bash
# Balancer workflow-agent-path E2E (DO NOT RUN in CI without a live stack).
#
# Task 13: WorkflowAgentService.run() now leases ONE endpoint from the
# balancer's `workflow` pool (EndpointAllocator + BalancerGateway.runAgent)
# instead of reading a fixed endpoint from the `workflow_agent_endpoint_v1`
# setting. This script proves the whole path end to end: registry endpoint →
# allocator lease → LlmClient.chatNonStream → agent tool loop → workflow
# engine → node-run output.
#
# Requires: running backend on :3200 with $DEVGRIMOIRE_API_KEY and at least
# one project. Starts a tiny mock OpenAI-compatible NON-streaming server on
# :19997 (single-shot /v1/chat/completions JSON response, no tool_calls so the
# agent loop finishes after one turn) and registers it as a `workflow` pool
# endpoint, then:
#   1. creates a minimal PROJECT-scope workflow (trigger.manual → agent.task),
#   2. activates it,
#   3. starts a run,
#   4. polls until the run finishes,
#   5. asserts the agent.task node run succeeded and its `response` output
#      matches the mock's canned text.
#
# The mock host defaults to host.docker.internal (backend runs in docker, mock
# on the host — same convention as balancer-chat.sh/balancer-embed.sh).
# Override with MOCK_HOST.
set -euo pipefail
BASE="${BASE:-http://localhost:3200}"
KEY="${DEVGRIMOIRE_API_KEY:?set DEVGRIMOIRE_API_KEY}"
MOCK_HOST="${MOCK_HOST:-host.docker.internal}"
MOCK_PORT="${MOCK_PORT:-19997}"
CANNED_TEXT="Hello from the workflow balancer"

auth=(-H "Authorization: Bearer $KEY")
json=(-H "content-type: application/json")

# Mock OpenAI-compatible server: /v1/models (probe) + non-streaming /v1/chat/completions.
node -e '
const http=require("http");
const PORT=parseInt(process.env.MOCK_PORT||"19997",10);
http.createServer((req,res)=>{
  if (req.url && req.url.startsWith("/v1/models")) {
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({data:[{id:"mock-workflow"}]}));
    return;
  }
  if (req.url==="/v1/chat/completions") {
    let b="";req.on("data",d=>b+=d);req.on("end",()=>{
      res.setHeader("content-type","application/json");
      // Keep this literal in sync with $CANNED_TEXT below (single-quoted node
      // script below cannot interpolate the shell variable directly).
      res.end(JSON.stringify({
        choices:[{message:{content:"Hello from the workflow balancer",tool_calls:[]},finish_reason:"stop"}],
        usage:{prompt_tokens:12,completion_tokens:8},
      }));
    });
    return;
  }
  res.statusCode=404;res.end();
}).listen(PORT,()=>console.error("mock workflow-llm up on "+PORT));
' &
MOCK=$!
trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 1

# Register a `workflow`-pool endpoint pointing at the mock.
EP_ID=$(curl -s -X POST "$BASE/api/llm-endpoints" "${auth[@]}" "${json[@]}" \
  -d "{\"label\":\"mock-workflow\",\"provider\":\"openai-compatible\",\"baseUrl\":\"http://$MOCK_HOST:$MOCK_PORT\",\"model\":\"mock-workflow\",\"purposes\":[\"workflow\"],\"concurrency\":2}" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
[ -n "$EP_ID" ] || { echo "FAIL: endpoint not created"; exit 1; }
echo "endpoint=$EP_ID"

# Pick a project (first one) to scope the workflow.
PROJECT_ID="${PROJECT_ID:-$(curl -s "$BASE/api/projects" "${auth[@]}" \
  | node -e 'process.stdin.on("data",d=>{const a=JSON.parse(d);const p=Array.isArray(a)?a:(a.items||a.data||[]);console.log(p[0]&&(p[0].id||p[0]._id)||"")})')}"
[ -n "$PROJECT_ID" ] || { echo "FAIL: no project available (set PROJECT_ID)"; exit 1; }
echo "project=$PROJECT_ID"

# Create a minimal workflow: manual trigger → agent.task (no tools needed —
# the mock never returns tool_calls, so the loop finishes after one turn).
DEF_ID=$(curl -s -X POST "$BASE/api/workflows" "${auth[@]}" "${json[@]}" -d @- <<EOF | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id||JSON.parse(d)._id))'
{
  "scope": "project",
  "projectId": "$PROJECT_ID",
  "name": "balancer-workflow-e2e",
  "trigger": { "type": "manual" },
  "nodes": [
    { "id": "trigger", "type": "trigger.manual", "position": { "x": 0, "y": 0 }, "config": {} },
    {
      "id": "agent",
      "type": "agent.task",
      "position": { "x": 200, "y": 0 },
      "config": {
        "prompt": "Say hello.",
        "allowedTools": [],
        "timeoutMs": 30000,
        "maxToolIterations": 3
      }
    }
  ],
  "edges": [
    { "id": "trigger-agent", "source": "trigger", "target": "agent", "branch": "success" }
  ]
}
EOF
)
[ -n "$DEF_ID" ] || { echo "FAIL: workflow definition not created"; exit 1; }
echo "definition=$DEF_ID"

# Activate (draft → active); the engine validates the graph on this transition.
curl -s -X PUT "$BASE/api/workflows/$DEF_ID" "${auth[@]}" "${json[@]}" \
  -d '{"status":"active"}' >/dev/null

# Start a run.
RUN_ID=$(curl -s -X POST "$BASE/api/workflows/runs" "${auth[@]}" "${json[@]}" \
  -d "{\"definitionId\":\"$DEF_ID\"}" \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id||JSON.parse(d)._id))')
[ -n "$RUN_ID" ] || { echo "FAIL: run not started"; exit 1; }
echo "run=$RUN_ID"

# Poll until the run leaves queued/running (agent lease + non-streaming call
# should be fast against the mock; give it up to ~30s).
STATUS=""
for _ in $(seq 1 30); do
  STATUS=$(curl -s "$BASE/api/workflows/runs/$RUN_ID/inspection" "${auth[@]}" \
    | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).run.status))')
  [ "$STATUS" = "succeeded" ] || [ "$STATUS" = "failed" ] && break
  sleep 1
done
echo "run status=$STATUS"
[ "$STATUS" = "succeeded" ] || { echo "FAIL: run did not succeed (status=$STATUS)"; exit 1; }

# Inspect the agent node run's output.
NODE_RUNS=$(curl -s "$BASE/api/workflows/runs/$RUN_ID/node-runs" "${auth[@]}")
echo "--- node runs ---"
echo "$NODE_RUNS" | head -c 2000
echo
echo "-----------------"
echo "$NODE_RUNS" | grep -q "$CANNED_TEXT" || { echo "FAIL: agent response missing from node-run output"; exit 1; }

# Cleanup.
curl -s -X DELETE "$BASE/api/workflows/$DEF_ID" "${auth[@]}" >/dev/null || true
curl -s -X DELETE "$BASE/api/llm-endpoints/$EP_ID" "${auth[@]}" >/dev/null || true
echo "balancer-workflow OK"
