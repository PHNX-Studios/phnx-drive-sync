"""Command-line entry point for the GUI.

    phnx-drive-sync-gui [PATH] [--self-check] [--version]

PATH is optional; it may be an absolute path under the mount/tree or a path
relative to the sync root.
"""

import sys

from . import paths, util

USAGE = """usage: phnx-drive-sync-gui [PATH] [--self-check] [--version]

Open the PHNX Drive Sync file manager. PATH, if given, is the folder to open
(absolute under ~/Proton Drive, or relative to the sync root).

  --self-check   build the window and exit (used by CI)
  --version      print the version
"""


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)

    self_check = "--self-check" in args
    args = [a for a in args if a != "--self-check"]

    if any(a in ("--version", "-V") for a in args):
        print(util.app_version())
        return 0
    if any(a in ("--help", "-h") for a in args):
        print(USAGE)
        return 0

    positional = [a for a in args if not a.startswith("-")]
    start_rel = paths.to_rel(positional[0]) if positional else ""

    # Import late so --version / --help work without a display or GTK.
    from .app import PhnxApplication

    application = PhnxApplication(start_rel=start_rel, self_check=self_check, unique=not self_check)
    return application.run([])


if __name__ == "__main__":
    sys.exit(main())
