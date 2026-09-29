#!/usr/bin/env bash
# Puts the site in this folder behind the front nginx, with no downtime.
#
#   bash tools/deploy.sh --check      reads only; reports what a deploy would do
#   bash tools/deploy.sh              builds, starts, tests, then switches
#   bash tools/deploy.sh --rollback   switches back to what was live before
#
# How it avoids downtime: the new site starts in its own container beside the
# one that is live. The front nginx is pointed at it only after it answers
# correctly, and nginx reloads without dropping connections. The container that
# was live keeps running, so going back is one reload.

set -euo pipefail

FRONT="${FRONT:-desertrip_mvp-nginx-1}"   # the nginx that holds ports 80 and 443
UPSTREAM="${UPSTREAM:-react_app}"         # the upstream block in its config
SITE_HOST="${SITE_HOST:-desertbooker.com}"
IMAGE="${IMAGE:-desertbooker-site}"
CONF_IN_FRONT="${CONF_IN_FRONT:-/etc/nginx/conf.d/default.conf}"
CONF="${CONF:-}"                          # found from the container when empty
TMP=""

trap '[ -z "$TMP" ] || rm -f "$TMP"' EXIT

cd "$(dirname "$0")/.."

say()  { printf '%s\n' "$*"; }
row()  { printf '  %-22s %s\n' "$1" "$2"; }
fail() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
front() { docker exec "$FRONT" "$@"; }

# The "server ...;" targets inside the upstream block of a config file.
targets() {
  awk -v name="$UPSTREAM" '
    $1 == "upstream" && $2 == name { inside = 1 }
    inside && $1 == "server" { t = $2; sub(/;$/, "", t); print t }
    inside && /\}/ { inside = 0 }
  ' "$1"
}

# The config file with the upstream pointed at "$2". Nothing else changes.
retarget() {
  awk -v name="$UPSTREAM" -v target="$2" '
    $1 == "upstream" && $2 == name { inside = 1 }
    inside && $1 == "server" { sub(/server[ \t]+[^;]+;/, "server " target ";") }
    { print }
    inside && /\}/ { inside = 0 }
  ' "$1"
}

# The config is mounted into the container as a single file. Writing into the
# file keeps that link; replacing the file (mv, sed -i) would silently break it.
write_conf() { cat "$1" > "$CONF"; }

fetch() {
  if [ "$TOOL" = curl ]; then front curl -fsS -m 10 "$1"; else front wget -q -T 10 -O - "$1"; fi
}

# The page as a visitor gets it, asked from inside the front container.
visitor() {
  if [ "$TOOL" = curl ]; then
    front curl -fsSk -m 10 --resolve "$SITE_HOST:443:127.0.0.1" "https://$SITE_HOST$1"
  else
    front wget -q -T 10 --no-check-certificate --header "Host: $SITE_HOST" -O - "https://127.0.0.1$1"
  fi
}

page_of() { grep -o 'assets/[A-Za-z]*-[A-Za-z0-9_-]*\.js' | head -n 1 || true; }

healthy() {
  local host="$1" try
  for try in 1 2 3 4 5 6 7 8 9 10; do
    if fetch "http://$host/" 2>/dev/null | grep -q "$BUNDLE" &&
       fetch "http://$host/$BUNDLE" >/dev/null 2>&1 &&
       fetch "http://$host/privacy-policy/" >/dev/null 2>&1 &&
       fetch "http://$host/terms-of-service/" >/dev/null 2>&1 &&
       fetch "http://$host/robots.txt" 2>/dev/null | grep -q 'Sitemap:'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

live_shows() {
  local want="$1" try
  for try in 1 2 3 4 5 6 7 8 9 10; do
    if visitor / 2>/dev/null | grep -q "$want"; then return 0; fi
    sleep 1
  done
  return 1
}

discover() {
  PROBLEMS=0
  command -v docker >/dev/null 2>&1 || fail "docker is not installed on this machine."
  docker inspect "$FRONT" >/dev/null 2>&1 || fail "there is no container called $FRONT."
  [ "$(docker inspect -f '{{.State.Running}}' "$FRONT")" = true ] || fail "$FRONT is not running."

  NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$FRONT" |
    sed '/^$/d' | head -n 1)"
  if [ -z "$CONF" ]; then
    CONF="$(docker inspect -f \
      "{{range .Mounts}}{{if eq .Destination \"$CONF_IN_FRONT\"}}{{.Source}}{{end}}{{end}}" "$FRONT")"
  fi
  if front sh -c 'command -v curl >/dev/null 2>&1'; then TOOL=curl; else TOOL=wget; fi

  BUNDLE="$(page_of < index.html)"
  COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  CURRENT=""
  [ -f "$CONF" ] && CURRENT="$(targets "$CONF")"
  LIVE_PAGE="$(visitor / 2>/dev/null | page_of)"
}

report() {
  say "DesertBooker deploy"
  row "Front container" "$FRONT (running)"
  row "Docker network" "${NET:-not found}"
  row "Config file" "${CONF:-not found}"
  row "Live target now" "${CURRENT:-not found}"
  row "Live page now" "${LIVE_PAGE:-could not read it}"
  row "This folder" "commit $COMMIT, page ${BUNDLE:-not found}"
  row "Free disk" "$(df -h . 2>/dev/null | awk 'NR == 2 { print $4 }')"
  say ""

  problem() { say "  PROBLEM: $*"; PROBLEMS=$((PROBLEMS + 1)); }
  [ -n "$NET" ] || problem "the front container is on no Docker network."
  [ -n "$BUNDLE" ] || problem "index.html here names no assets/about-....js file."
  [ -f Dockerfile ] || problem "there is no Dockerfile in this folder."
  if [ -z "$CONF" ]; then
    problem "no file is mounted at $CONF_IN_FRONT in the front container."
  elif [ ! -f "$CONF" ]; then
    problem "the config file $CONF is not on this machine."
  else
    [ -w "$CONF" ] || problem "this user may not write $CONF. Run the command with sudo."
    case "$(printf '%s\n' "$CURRENT" | sed '/^$/d' | wc -l | tr -d ' ')" in
      1) ;;
      0) problem "the config has no 'upstream $UPSTREAM' block with a server line." ;;
      *) problem "the 'upstream $UPSTREAM' block has more than one server line." ;;
    esac
    front nginx -t >/dev/null 2>&1 || problem "the config that is live now does not pass 'nginx -t'."
    # Same file on both sides has the same inode. A different one means the
    # file was replaced after the container started, and edits no longer reach it.
    if [ "$(stat -c %i "$CONF" 2>/dev/null)" != "$(front stat -c %i "$CONF_IN_FRONT" 2>/dev/null)" ]; then
      problem "the front container holds an older copy of $CONF; edits to the file do not reach it."
    fi
  fi
}

restore() {
  write_conf "$BACKUP"
  if front nginx -t >/dev/null 2>&1; then front nginx -s reload >/dev/null 2>&1 || true; fi
}

check() {
  discover
  report
  if [ "$PROBLEMS" -eq 0 ]; then
    say "RESULT: READY. Nothing was changed. To deploy, run: bash tools/deploy.sh"
  else
    say "RESULT: NOT READY. Nothing was changed. Send this whole report."
    exit 1
  fi
}

deploy() {
  discover
  report
  [ "$PROBLEMS" -eq 0 ] || fail "fix the problems above first. Nothing was changed."

  local tag name
  tag="$(date -u +%Y%m%d-%H%M%S)"
  name="$IMAGE-$tag"
  TMP="$(mktemp)"
  BACKUP="$CONF.before-$tag"

  say "1/6  Building the new site"
  docker build -q -t "$IMAGE:$tag" -t "$IMAGE:latest" . >/dev/null

  say "2/6  Starting it beside the live one"
  docker run -d --name "$name" --network "$NET" --restart unless-stopped "$IMAGE:$tag" >/dev/null

  say "3/6  Testing it before any visitor sees it"
  if ! healthy "$name"; then
    docker logs --tail 20 "$name" 2>&1 | sed 's/^/     /' || true
    docker rm -f "$name" >/dev/null
    fail "the new site did not answer correctly. Visitors still get the old site; nothing was changed."
  fi

  say "4/6  Pointing the front door at it"
  cp -p "$CONF" "$BACKUP"
  retarget "$CONF" "$name:80" > "$TMP"
  write_conf "$TMP"
  if ! front grep -q "server $name:80;" "$CONF_IN_FRONT"; then
    write_conf "$BACKUP"
    docker rm -f "$name" >/dev/null
    fail "the front container does not see changes to $CONF. Nothing was changed for visitors."
  fi
  if ! front nginx -t >/dev/null 2>&1; then
    front nginx -t 2>&1 | sed 's/^/     /' || true
    write_conf "$BACKUP"
    docker rm -f "$name" >/dev/null
    fail "nginx refused the new config. It was put back; visitors still get the old site."
  fi
  front nginx -s reload >/dev/null 2>&1

  say "5/6  Checking what visitors get"
  if ! live_shows "$BUNDLE"; then
    restore
    docker rm -f "$name" >/dev/null
    fail "the live site did not show the new page. The old site was put back."
  fi

  say "6/6  Tidying up"
  # Keep the container that was live until now, for a rollback. Remove older ones.
  docker ps -a --format '{{.Names}}' | grep "^$IMAGE-[0-9]" | while read -r old; do
    [ "$old" = "$name" ] && continue
    [ "$old:80" = "$CURRENT" ] && continue
    docker rm -f "$old" >/dev/null 2>&1 || true
  done

  say ""
  say "RESULT: LIVE. Visitors now get $BUNDLE from $name."
  say "  Was live before:  $CURRENT (still running)"
  say "  Config backup:    $BACKUP"
  say "  To go back:       bash tools/deploy.sh --rollback"
}

rollback() {
  discover
  [ -n "$CONF" ] && [ -f "$CONF" ] || fail "the config file was not found."
  BACKUP="$(ls -1t "$CONF".before-* 2>/dev/null | head -n 1 || true)"
  [ -n "$BACKUP" ] || fail "there is no backup beside $CONF, so there is nothing to go back to."

  local now before
  now="$CURRENT"
  before="$(targets "$BACKUP")"
  TMP="$(mktemp)"
  say "Going back from $now to $before"

  cp -p "$CONF" "$TMP"
  write_conf "$BACKUP"
  if ! front nginx -t >/dev/null 2>&1; then
    front nginx -t 2>&1 | sed 's/^/     /' || true
    write_conf "$TMP"
    fail "nginx refused the old config, most likely because $before is no longer running. Nothing was changed."
  fi
  front nginx -s reload >/dev/null 2>&1
  sleep 2
  mv "$BACKUP" "$BACKUP.used"
  say "RESULT: ROLLED BACK. Visitors now get: $(visitor / 2>/dev/null | page_of)"
  say "  $now is still running and can be removed with: docker rm -f ${now%:*}"
}

case "${1:-}" in
  --check) check ;;
  --rollback) rollback ;;
  "") deploy ;;
  *) fail "unknown option $1. Use --check, --rollback, or nothing." ;;
esac
