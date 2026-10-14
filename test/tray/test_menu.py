"""Structural guard for the tray menu.

Parses the tray source with ast (no GTK/AppIndicator import, so it runs anywhere)
and asserts the maintainer's requirements: every action item is top level (no
submenus), the app-opening item and the sync item are present and wired, and the
old "Actions" submenu is gone.
"""

import ast
import os
import unittest

TRAY = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "tray", "phnx-drive-sync-tray.py"))


def _parse() -> ast.Module:
    with open(TRAY, encoding="utf-8") as handle:
        return ast.parse(handle.read(), filename=TRAY)


def _main_def(tree: ast.Module) -> ast.FunctionDef:
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "main":
            return node
    raise AssertionError("main() not found in the tray source")


def _is_menu_item_call(node: ast.Call) -> bool:
    func = node.func
    return isinstance(func, ast.Attribute) and func.attr == "MenuItem"


class TrayMenu(unittest.TestCase):
    def setUp(self):
        self.tree = _parse()
        self.main = _main_def(self.tree)

    def test_no_submenus_anywhere(self):
        offenders = [
            node.lineno
            for node in ast.walk(self.tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "set_submenu"
        ]
        self.assertEqual(offenders, [], f"set_submenu() still used at lines {offenders}; all items must be top level")

    def test_expected_top_level_items(self):
        labels = self._menu_labels()
        for label in (
            "Sync now",
            "Open PHNX Drive Sync",
            "Open Proton Drive folder",
            "Show last log",
            "Pause syncing",
            "Quit tray icon",
        ):
            self.assertIn(label, labels)
        self.assertNotIn("Actions", labels)

    def test_app_open_and_sync_are_wired(self):
        callbacks = self._activate_callbacks()
        self.assertIn("open_app", callbacks)
        self.assertIn("sync_now", callbacks)

    def test_open_app_is_defined(self):
        names = {node.name for node in self.tree.body if isinstance(node, ast.FunctionDef)}
        self.assertIn("open_app", names)

    def _menu_labels(self):
        labels = []
        for node in ast.walk(self.main):
            if isinstance(node, ast.Call) and _is_menu_item_call(node):
                for keyword in node.keywords:
                    if keyword.arg == "label" and isinstance(keyword.value, ast.Constant):
                        labels.append(keyword.value.value)
        return labels

    def _activate_callbacks(self):
        names = set()
        for node in ast.walk(self.main):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "connect"):
                continue
            if len(node.args) < 2:
                continue
            signal, target = node.args[0], node.args[1]
            if isinstance(signal, ast.Constant) and signal.value == "activate" and isinstance(target, ast.Name):
                names.add(target.id)
        return names


if __name__ == "__main__":
    unittest.main()
