#!/bin/sh
# ===========================================================
#  Phrontis one-click launcher -- POSIX counterpart of
#  scripts/start-desktop.bat.
#
#  Comments are kept in ASCII/English on purpose: this file shares
#  its lineage with start-desktop.bat, where ASCII-only content is a
#  hard rule (cmd.exe parses .bat in the OEM codepage). A POSIX shell
#  has no such restriction -- UTF-8 and LF are correct here -- but the
#  two files read best side by side.
#
#  What it does:
#    1. locate node (a .desktop-launched process inherits only the
#       session PATH, which is missing nvm/fnm/volta shims and
#       portable installs -- same reasoning as the .bat);
#    2. cd into the repository THIS script lives in (self-locating:
#       a worktree copy starts its own worktree, not the main checkout);
#    3. hand over to scripts/start-desktop.js, which does the real work
#       (dependency install, log file, integrity preflight, dev launch).
#
#  Used by the generated desktop entry (see
#  .AGENT/scripts/worktree-launcher/desktop-launcher.mjs).
# ===========================================================
set -u

# --- 1. Locate node -----------------------------------------
NODE_EXE=""

if command -v node >/dev/null 2>&1; then
  NODE_EXE=$(command -v node)
fi

if [ -z "$NODE_EXE" ]; then
  # Version managers first (they are the ones missing from a .desktop PATH),
  # then the usual system locations.
  if [ -d "$HOME/.nvm/versions/node" ]; then
    cand=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
    [ -n "$cand" ] && [ -x "$cand" ] && NODE_EXE="$cand"
  fi
  for d in \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/.volta/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME/.local/bin/node" \
    /usr/local/bin/node \
    /usr/bin/node \
    /snap/bin/node
  do
    if [ -z "$NODE_EXE" ] && [ -x "$d" ]; then NODE_EXE="$d"; fi
  done
fi

# Machine-local override: scripts/node-path.local.txt holds the folder of the
# node install on one line. Git-ignored on purpose (an absolute machine path
# must not enter version control). Same convention as the .bat.
if [ -z "$NODE_EXE" ] && [ -f "$(dirname "$0")/node-path.local.txt" ]; then
  while IFS= read -r line; do
    if [ -z "$NODE_EXE" ] && [ -n "$line" ] && [ -x "$line/node" ]; then NODE_EXE="$line/node"; fi
  done < "$(dirname "$0")/node-path.local.txt"
fi

if [ -z "$NODE_EXE" ]; then
  echo "[launcher] Node.js not found."
  echo "[launcher] Either put its folder on PATH, or write that folder"
  echo "[launcher] on a single line into scripts/node-path.local.txt"
  echo "[launcher] Example: /home/you/.nvm/versions/node/v24.22.0/bin"
  if [ -t 0 ]; then printf '[launcher] Press Enter to close this window. '; read -r _ || true; fi
  exit 1
fi

# --- 2. Run from the repository this script lives in ----------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.." || exit 1

# --- 3. Hand over --------------------------------------------
# The window is kept open on exit on purpose: the dev server can print its
# failure after the child is already gone, and a short-lived terminal is
# exactly how that error gets lost. The same output is also written to
# logs/launch-last.log by start-desktop.js.
"$NODE_EXE" scripts/start-desktop.js
RC=$?
echo
echo "[launcher] start-desktop.js exited with code $RC."
echo "[launcher] Full output: logs/launch-last.log"
if [ -t 0 ]; then printf '[launcher] Press Enter to close this window. '; read -r _ || true; fi
exit $RC
