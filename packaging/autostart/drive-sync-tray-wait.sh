#!/bin/sh
# XDG autostart wrapper for drive-sync-tray.py.
# Wait for repo on mounted storage (mounts late after login), then exec with clean env.
target="$HOME/storage/Projects/drive-sync/tray/drive-sync-tray.py"
i=0
while [ ! -x "$target" ]; do
  i=$((i + 1))
  [ "$i" -ge 600 ] && exit 1
  sleep 1
done
export GI_TYPELIB_PATH="$HOME/.local/lib/girepository-1.0"
export PYTHONUNBUFFERED=1
export NO_AT_BRIDGE=1
export XDG_CURRENT_DESKTOP=ubuntu:GNOME
exec /usr/bin/python3 "$target"
