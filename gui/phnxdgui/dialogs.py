"""Alert/confirm/prompt dialogs.

Uses Adw.AlertDialog when available (libadwaita >= 1.5) and falls back to the
older Adw.MessageDialog, which shares the same response API, so the GUI runs on
older distros too.
"""

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gtk


def _dialog_class():
    return getattr(Adw, "AlertDialog", None) or Adw.MessageDialog


def _present(dialog, parent):
    if parent is not None:
        dialog.present(parent)
    else:
        dialog.present(None)


def error(parent, heading: str, body: str = "") -> None:
    dialog = _dialog_class().new(heading, body)
    dialog.add_response("close", "Close")
    dialog.set_default_response("close")
    dialog.set_close_response("close")
    _present(dialog, parent)


def confirm(parent, heading: str, body: str, on_confirm, confirm_label="Delete", destructive=True) -> None:
    dialog = _dialog_class().new(heading, body)
    dialog.add_response("cancel", "Cancel")
    dialog.add_response("ok", confirm_label)
    if destructive:
        dialog.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE)
    else:
        dialog.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
    dialog.set_default_response("cancel")
    dialog.set_close_response("cancel")

    def on_response(_dialog, response):
        if response == "ok":
            on_confirm()

    dialog.connect("response", on_response)
    _present(dialog, parent)


def prompt(parent, heading: str, body: str, initial: str, on_accept, accept_label="OK") -> None:
    dialog = _dialog_class().new(heading, body)
    dialog.add_response("cancel", "Cancel")
    dialog.add_response("ok", accept_label)
    dialog.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
    dialog.set_default_response("ok")
    dialog.set_close_response("cancel")

    entry = Gtk.Entry()
    entry.set_text(initial)
    entry.set_activates_default(True)
    entry.set_hexpand(True)
    # Select the basename so a rename starts with the name highlighted.
    entry.select_region(0, len(initial))
    dialog.set_extra_child(entry)

    def on_response(_dialog, response):
        if response == "ok":
            value = entry.get_text().strip()
            if value:
                on_accept(value)

    dialog.connect("response", on_response)
    _present(dialog, parent)
