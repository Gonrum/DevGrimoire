#!/bin/sh
# Git credential helper for DevGrimoire workspaces (T-541).
#
# Hands out the Git token from the ENVIRONMENT of the calling git process —
# nothing is ever written to disk, so `.git/config` stays token-free and a
# command without injected credentials gets nothing.
#
#   DG_GIT_HOST + DG_GIT_USERNAME + DG_GIT_PASSWORD
#       one-shot credentials the sidecar sets for a single clone/pull,
#       bound to exactly that host
#   GH_TOKEN                      -> github.com          (x-access-token)
#   GITLAB_TOKEN [+ GITLAB_HOST]  -> GITLAB_HOST, default gitlab.com (oauth2)
#   GITEA_TOKEN + GITEA_HOST      -> GITEA_HOST          (oauth2)
#
# A token is never offered to a host it was not configured for, and only
# over https (plain http only with the test-only DG_GIT_ALLOW_HTTP=1). Only
# the `get` action answers; `store`/`erase` are no-ops (nothing to persist).

[ "$1" = "get" ] || exit 0

host=""
protocol=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*) host="${line#host=}" ;;
    protocol=*) protocol="${line#protocol=}" ;;
  esac
done
[ -n "$host" ] || exit 0
case "$protocol" in
  https) ;;
  http) [ "$DG_GIT_ALLOW_HTTP" = "1" ] || exit 0 ;;
  *) exit 0 ;;
esac

emit() {
  printf 'username=%s\npassword=%s\n' "$1" "$2"
  exit 0
}

if [ -n "$DG_GIT_HOST" ] && [ "$host" = "$DG_GIT_HOST" ] && [ -n "$DG_GIT_PASSWORD" ]; then
  emit "${DG_GIT_USERNAME:-oauth2}" "$DG_GIT_PASSWORD"
fi
if [ -n "$GH_TOKEN" ] && [ "$host" = "github.com" ]; then
  emit "x-access-token" "$GH_TOKEN"
fi
if [ -n "$GITLAB_TOKEN" ] && [ "$host" = "${GITLAB_HOST:-gitlab.com}" ]; then
  emit "oauth2" "$GITLAB_TOKEN"
fi
if [ -n "$GITEA_TOKEN" ] && [ -n "$GITEA_HOST" ] && [ "$host" = "$GITEA_HOST" ]; then
  emit "oauth2" "$GITEA_TOKEN"
fi
exit 0
