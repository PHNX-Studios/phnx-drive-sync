"""The packaged GUI version must track the root package.json.

The root ``package.json`` is the release source of truth: ``packaging/build.sh``
stamps its version into the tarball's ``VERSION`` file, which the app prefers at
runtime. The ``phnxdgui.__version__`` constant is only the dev-checkout fallback,
so it has to stay equal to the same value (it drifted before: 0.3.2 vs 0.4.0).
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

import phnxdgui  # noqa: E402

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class Version(unittest.TestCase):
    def test_matches_package_json(self):
        with open(os.path.join(_ROOT, "package.json"), encoding="utf-8") as handle:
            packaged = json.load(handle)["version"]
        self.assertEqual(phnxdgui.__version__, packaged)


if __name__ == "__main__":
    unittest.main()
