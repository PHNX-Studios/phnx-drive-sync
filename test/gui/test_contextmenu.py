"""Context-menu spec tests (pure model, no display required).

Exercises the display-free part of ``phnxdgui.contextmenu``: the SelectionContext
built from the selected rows and the menu sections derived from it.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

from phnxdgui import contextmenu  # noqa: E402


class FakeRow:
    """Duck-typed stand-in for FileRow (only the fields the spec reads)."""

    def __init__(self, is_dir=False, presence="local", pinned=False):
        self.is_dir = is_dir
        self.presence = presence
        self.pinned = pinned


def actions(spec):
    return [action for section in spec for _label, action in section]


def labels(spec):
    return [label for section in spec for label, _action in section]


class ContextFor(unittest.TestCase):
    def test_empty_is_background(self):
        ctx = contextmenu.context_for([])
        self.assertEqual(ctx.count, 0)
        self.assertTrue(ctx.engine_up)

    def test_single_file_fields(self):
        ctx = contextmenu.context_for([FakeRow(presence="online", pinned=True)])
        self.assertEqual(ctx.count, 1)
        self.assertFalse(ctx.single_dir)
        self.assertTrue(ctx.all_online)
        self.assertTrue(ctx.all_pinned)

    def test_single_dir_fields(self):
        ctx = contextmenu.context_for([FakeRow(is_dir=True)])
        self.assertEqual(ctx.count, 1)
        self.assertTrue(ctx.single_dir)
        self.assertFalse(ctx.all_online)
        self.assertFalse(ctx.all_pinned)

    def test_multi_aggregates_state(self):
        all_pinned = contextmenu.context_for([FakeRow(pinned=True), FakeRow(pinned=True)])
        self.assertEqual(all_pinned.count, 2)
        self.assertTrue(all_pinned.all_pinned)
        self.assertFalse(contextmenu.context_for([FakeRow(pinned=True), FakeRow()]).all_pinned)

        all_online = contextmenu.context_for([FakeRow(presence="online"), FakeRow(presence="online")])
        self.assertTrue(all_online.all_online)
        self.assertFalse(contextmenu.context_for([FakeRow(presence="online"), FakeRow()]).all_online)

    def test_engine_flag_is_coerced(self):
        ctx = contextmenu.context_for([], engine_up=0)
        self.assertFalse(ctx.engine_up)


class ItemMenu(unittest.TestCase):
    def test_single_local_file(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([FakeRow()]))
        self.assertEqual(actions(spec), ["win.open", "win.pin", "win.unpin", "win.rename", "win.trash"])

    def test_single_online_file_hides_free_up_space(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([FakeRow(presence="online")]))
        self.assertEqual(actions(spec), ["win.open", "win.pin", "win.rename", "win.trash"])

    def test_single_pinned_file_hides_keep(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([FakeRow(pinned=True)]))
        self.assertEqual(actions(spec), ["win.open", "win.unpin", "win.rename", "win.trash"])

    def test_single_directory(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([FakeRow(is_dir=True)]))
        self.assertEqual(actions(spec), ["win.open", "win.pin", "win.unpin", "win.rename", "win.trash"])

    def test_multi_selection_hides_open_and_rename(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([FakeRow(), FakeRow()]))
        self.assertEqual(actions(spec), ["win.pin", "win.unpin", "win.trash"])

    def test_multi_all_pinned_hides_keep(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([FakeRow(pinned=True), FakeRow(pinned=True)]))
        self.assertEqual(actions(spec), ["win.unpin", "win.trash"])

    def test_multi_all_online_hides_free_up_space(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([FakeRow(presence="online"), FakeRow(presence="online")]))
        self.assertEqual(actions(spec), ["win.pin", "win.trash"])

    def test_engine_down_hides_engine_actions(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([FakeRow()], engine_up=False))
        self.assertEqual(actions(spec), ["win.open", "win.rename", "win.trash"])


class BackgroundMenu(unittest.TestCase):
    def test_background(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([], engine_up=True))
        self.assertEqual(actions(spec), ["win.new-folder", "win.sync-now", "win.evict-all", "win.edit-filters"])

    def test_background_engine_down(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([], engine_up=False))
        self.assertEqual(actions(spec), ["win.new-folder", "win.edit-filters"])


class Sections(unittest.TestCase):
    def test_no_empty_sections(self):
        contexts = [
            contextmenu.context_for([]),
            contextmenu.context_for([FakeRow()]),
            contextmenu.context_for([FakeRow(presence="online", pinned=True)]),
            contextmenu.context_for([FakeRow(), FakeRow()]),
            contextmenu.context_for([FakeRow()], engine_up=False),
            contextmenu.context_for([], engine_up=False),
        ]
        for ctx in contexts:
            spec = contextmenu.menu_spec_for(ctx)
            self.assertTrue(spec)
            for section in spec:
                self.assertTrue(section)

    def test_labels_are_present(self):
        spec = contextmenu.menu_spec_for(contextmenu.context_for([FakeRow()]))
        self.assertIn("Open", labels(spec))
        self.assertIn("Move to trash", labels(spec))


if __name__ == "__main__":
    unittest.main()
