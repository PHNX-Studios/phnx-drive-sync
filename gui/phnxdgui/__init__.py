"""PHNX Drive Sync file manager GUI (unofficial client).

A GTK4 + Libadwaita file browser over the FUSE mount at ~/Proton Drive, with
per-file sync status supplied by the engine over its unix-socket RPC.

The engine owns every sync fact; this package only presents them and forwards
user actions (open, keep on device, free up space) to the engine or to the
mount. Nothing here touches Proton's API directly.
"""

__all__ = ["__version__"]

# Kept in sync with the release VERSION file the installer deploys; the app
# prefers the installed file at runtime and falls back to this constant.
__version__ = "0.6.1"
