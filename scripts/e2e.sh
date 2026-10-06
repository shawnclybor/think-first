#!/usr/bin/env bash
# e2e.sh — think-first in real `claude -p` sessions. Costs four short model runs.
# WebFetch stands in for a write, so nothing outside this machine is changed.
#
# Needs a sequential-thinking server configured (see README, "What it needs").
#   A  no thinking step             -> WebFetch blocked as a write
#   B  thinking step first          -> a sequentialthinking tool runs, then WebFetch runs
#   C  fetch fails, retried at once -> the retry is blocked (writes off, retries=WebFetch)
#   D  gate OFF, same as A          -> WebFetch runs (proves A's block came from think-first)
#   E  gate on, thinking first, plus a settings hook -> the hook sees THINK_FIRST_ACTIVE=1
#   F  same hook, no think-first    -> the hook sees it unset (the marker came from think-first)
#
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
OUT="$(mktemp -d)"
NAME=think-first

# Isolation: other copies of this plugin (installed, or synced from your account) would
# also load and blur the test. Every run below disables them, so "gate on" means only the
# copy under test and "gate off" means no copy at all.
iso() { # $1 = fixture settings file or "" -> prints a merged settings file
  python3 - "$1" "$OUT" "$NAME" <<'PY'
import json, os, sys, tempfile
src, out, name = sys.argv[1:4]
d = json.load(open(src)) if src else {}
d.setdefault("enabledPlugins", {}).update({f"{name}@synced": False, f"{name}@clybor-plugins": False, f"life-crm-{name}@synced": False})
fd, path = tempfile.mkstemp(suffix=".json", dir=out); os.write(fd, json.dumps(d).encode()); os.close(fd)
print(path)
PY
}
COMMON=(--permission-mode bypassPermissions --max-turns 8 --output-format stream-json --verbose)
ON=(--plugin-dir . --settings "$(iso tests/fixtures/e2e-settings.json)")

A="Use WebFetch to fetch https://example.com and tell me its title. Do not call any thinking tool first. If a call is blocked, quote the block message exactly and stop."
B="First call the sequentialthinking tool once with thoughtNumber 1, totalThoughts 1, nextThoughtNeeded false, thought 'plan the fetch'. Then use WebFetch to fetch https://example.com and tell me its title. Quote any block message exactly."
C="Use WebFetch to fetch https://nonexistent.invalid/page. If it fails, immediately make the exact same WebFetch call again, with no other tool call in between. Quote any block message exactly, then stop."

claude -p "$A" "${ON[@]}" "${COMMON[@]}" < /dev/null > "$OUT/A.jsonl" 2>&1
claude -p "$B" "${ON[@]}" "${COMMON[@]}" < /dev/null > "$OUT/B.jsonl" 2>&1
claude -p "$C" --plugin-dir . --settings "$(iso tests/fixtures/e2e-retry-settings.json)" "${COMMON[@]}" < /dev/null > "$OUT/C.jsonl" 2>&1
claude -p "$A" --settings "$(iso "")" "${COMMON[@]}" < /dev/null > "$OUT/D.jsonl" 2>&1
HANDOFF_OUT="$OUT/E.env" claude -p "$B" --plugin-dir . --settings "$(iso tests/fixtures/e2e-handoff-settings.json)" "${COMMON[@]}" < /dev/null > "$OUT/E.jsonl" 2>&1
HANDOFF_OUT="$OUT/F.env" claude -p "$A" --settings "$(iso tests/fixtures/e2e-hook-only-settings.json)" "${COMMON[@]}" < /dev/null > "$OUT/F.jsonl" 2>&1

python3 - "$OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
def calls(leg):
    uses, results, servers = [], [], []
    for ln in open(os.path.join(out, leg + ".jsonl")):
        try: o = json.loads(ln)
        except ValueError: continue
        if o.get("type") == "system" and o.get("subtype") == "init":
            servers = [s.get("name") + ":" + s.get("status", "?") for s in o.get("mcp_servers", [])]
        for b in (o.get("message") or {}).get("content") or []:
            if not isinstance(b, dict): continue
            if b.get("type") == "tool_use": uses.append(b["name"])
            if b.get("type") == "tool_result": results.append(str(b.get("content")))
    return uses, results, servers
ok = True
def check(leg, cond, what):
    global ok
    print(f"{leg}: {'PASS' if cond else 'FAIL'} — {what}"); ok &= cond
u, r, s = calls("A")
check("A", "WebFetch" in u and any("think-first: blocked WebFetch because it is a write" in x for x in r),
      "write blocked before any thinking step")
u, r, s = calls("B")
st = [x for x in u if x.endswith("__sequentialthinking")]
check("B", bool(st) and "WebFetch" in u and not any("think-first: blocked" in x for x in r),
      f"thinking tool ran ({st[:1]}), then the write ran")
u, r, s = calls("C")
check("C", u.count("WebFetch") >= 2 and any("last call failed" in x for x in r), "immediate retry after a failure blocked")
u, r, s = calls("D")
check("D", "WebFetch" in u and not any("think-first: blocked" in x for x in r), "without think-first the write is not blocked")
def marker(leg):
    p = os.path.join(out, leg + ".env")
    return open(p).read() if os.path.exists(p) else "(hook never ran)"
check("E", marker("E") == "1", f"a settings hook started after think-first saw THINK_FIRST_ACTIVE={marker('E')}")
check("F", marker("F") == "unset", f"without think-first the same hook saw {marker('F')}")
print("transcripts:", out); sys.exit(0 if ok else 1)
PY
