"""Map an engine list entry to a visual badge.

Pure functions (no GTK) so the status model is unit-testable; the icon names are
resolved against the active icon theme at render time by the file browser.
"""

# Ordered icon candidates; the first one available in the theme wins. The custom
# emblem-cloud.svg the engine installs is preferred for online-only files, with
# standard symbolic fallbacks for themes that lack it.
CLOUD_ICONS = ("emblem-cloud", "weather-overcast-symbolic", "network-server-symbolic")
CHECK_ICONS = ("object-select-symbolic", "emblem-ok-symbolic")
PENDING_ICONS = ("emblem-synchronizing-symbolic", "dialog-warning-symbolic")
NEW_ICONS = ("document-new-symbolic", "dialog-information-symbolic")
FOLDER_ICONS = ("folder-symbolic",)
PIN_ICONS = ("view-pin-symbolic", "emblem-favorite-symbolic")

# CSS classes are defined in app.py.
CLOUD_CSS = "cloud"
SYNCED_CSS = "synced"
PENDING_CSS = "pending"
NEW_CSS = "newsync"
FOLDER_CSS = "dim"


def badge_for(entry: dict):
    """Return (icons, css_class, label) for an engine list entry dict.

    `entry` carries ``type`` (file|dir), ``presence`` (local|online),
    ``sync`` (clean|dirty|unsynced|n/a) and ``pinned`` (bool).
    """
    entry_type = entry.get("type")
    if entry_type == "dir":
        return (list(FOLDER_ICONS), FOLDER_CSS, "Folder")

    presence = entry.get("presence")
    sync = entry.get("sync")
    pinned = bool(entry.get("pinned"))

    if presence == "online":
        icons, css, label = CLOUD_ICONS, CLOUD_CSS, "Online only"
    elif sync == "clean":
        icons, css, label = CHECK_ICONS, SYNCED_CSS, "On this device"
    elif sync == "dirty":
        icons, css, label = PENDING_ICONS, PENDING_CSS, "Pending sync"
    else:
        icons, css, label = NEW_ICONS, NEW_CSS, "Not synced yet"

    if pinned:
        icons = tuple(icons) + PIN_ICONS
        label += "; kept on this device"
    return (list(icons), css, label)
