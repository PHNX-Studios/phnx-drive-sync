#!/usr/bin/env python3
"""Entry point for the PHNX Drive Sync file manager GUI.

Adds the gui/ directory (this file's directory) to sys.path so the phnxdgui
package resolves both from a dev checkout and from the installed runtime at
~/.local/lib/phnx-drive-sync/gui/.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phnxdgui.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
