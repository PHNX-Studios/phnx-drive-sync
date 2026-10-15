"""Right-click context menus for the file list.

The pure part (``SelectionContext`` / ``context_for`` / ``menu_spec_for``) has no
GTK dependency, so it is unit-testable without a display, mirroring ``badges.py``.
The GTK glue (``present``) imports Gtk lazily and renders one ``Gtk.Button`` per
spec item inside a ``Gtk.Popover``; each button activates the window's matching
``win.*`` action directly, so the context menu and the header menu drive identical
code paths (no duplicated file logic). Items that do not apply are omitted rather
than greyed out: hiding reads better in a context menu.

Driving the buttons through ``window.activate_action`` (instead of a
``Gio.Menu`` model resolved by ``Gtk.PopoverMenu``) matters: a popover parented to
a ``Gtk.ColumnView`` cell does not reliably reach the window's action group on
every backend, which left the menu visible but inert when an item was clicked.
"""

from dataclasses import dataclass


@dataclass
class SelectionContext:
    """What the right-click landed on.

    ``count == 0`` is a background click (empty space), ``1`` a single item,
    ``> 1`` a multi-selection. ``all_online`` / ``all_pinned`` describe the whole
    selection; ``single_dir`` is only meaningful when ``count == 1``.
    """

    count: int = 0
    single_dir: bool = False
    all_online: bool = False
    all_pinned: bool = False
    engine_up: bool = True


def context_for(rows, engine_up=True) -> SelectionContext:
    """Build a SelectionContext from the selected rows (duck-typed FileRows)."""
    rows = list(rows)
    ctx = SelectionContext(count=len(rows), engine_up=bool(engine_up))
    if rows:
        ctx.single_dir = len(rows) == 1 and bool(getattr(rows[0], "is_dir", False))
        ctx.all_online = all(getattr(row, "presence", None) == "online" for row in rows)
        ctx.all_pinned = all(bool(getattr(row, "pinned", False)) for row in rows)
    return ctx


def menu_spec_for(ctx: SelectionContext) -> list:
    """Return ordered sections of ``(label, action_name)`` for the context.

    Each inner list is one section (rendered with a separator between sections).
    Empty sections are dropped.
    """
    if ctx.count == 0:
        return _background_spec(ctx)
    return _item_spec(ctx)


def _item_spec(ctx: SelectionContext) -> list:
    primary = []
    if ctx.count == 1:
        primary.append(("Open", "win.open"))
    # Keep is redundant when every selected item is already keep-marked.
    if ctx.engine_up and not ctx.all_pinned:
        primary.append(("Keep on this device", "win.pin"))
    # Free up space is redundant when every selected item is already online.
    if ctx.engine_up and not ctx.all_online:
        primary.append(("Free up space", "win.unpin"))

    edit = []
    if ctx.count == 1:
        edit.append(("Rename", "win.rename"))

    danger = [("Move to trash", "win.trash")]

    return [section for section in (primary, edit, danger) if section]


def _background_spec(ctx: SelectionContext) -> list:
    create = [("New folder", "win.new-folder")]
    if ctx.engine_up:
        create.append(("Sync now", "win.sync-now"))

    maintenance = []
    if ctx.engine_up:
        maintenance.append(("Free up space (all local files)", "win.evict-all"))
    maintenance.append(("Edit ignore filters", "win.edit-filters"))

    return [section for section in (create, maintenance) if section]


# --- GTK glue ---------------------------------------------------------------

def _on_popover_closed(popover) -> None:
    # GTK4 does not unparent a popover automatically on dismiss.
    popover.unparent()


def present(window, widget, x, y, ctx: SelectionContext) -> None:
    """Build and pop up the context menu at (x, y) in ``widget`` coordinates.

    The items are plain ``Gtk.Button``s activated through ``window.activate_action``
    rather than a ``Gio.Menu`` model resolved by ``Gtk.PopoverMenu``. A popover
    parented to a ``Gtk.ColumnView`` cell does not reliably resolve the window's
    ``win.*`` action group on every backend, which made the menu appear but do
    nothing when an item was clicked; driving the exact same ``win.*`` actions
    directly from the button guarantees they fire (and keeps a single code path
    with the header menu and the accelerators).

    ``widget`` is the cell/widget the click landed on; ``window`` is the
    MainWindow (used to activate the action and to keep the popover referenced).
    """
    spec = menu_spec_for(ctx)
    if not spec:
        return

    from gi.repository import Gdk, Gtk

    previous = getattr(window, "_context_popover", None)
    if previous is not None:
        previous.popdown()

    content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    content.add_css_class("menu")
    for index, section_items in enumerate(spec):
        if index:
            content.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        for label, action in section_items:
            content.append(_menu_item(window, label, action))

    popover = Gtk.Popover()
    popover.add_css_class("menu")
    popover.set_child(content)
    popover.set_parent(widget)
    popover.set_has_arrow(False)
    rect = Gdk.Rectangle()
    rect.x = int(x)
    rect.y = int(y)
    rect.width = 1
    rect.height = 1
    popover.set_pointing_to(rect)
    popover.connect("closed", _on_popover_closed)
    popover.popup()

    # Keep a strong reference: an unreferenced popover can be garbage collected
    # before the user interacts with it.
    window._context_popover = popover


def _menu_item(window, label, action):
    from gi.repository import Gtk

    button = Gtk.Button(label=label)
    button.set_has_frame(False)
    button.set_halign(Gtk.Align.FILL)
    button.set_focus_on_click(False)
    button.add_css_class("flat")
    child = button.get_child()
    if isinstance(child, Gtk.Label):
        child.set_xalign(0)
        child.set_margin_start(6)
        child.set_margin_end(12)
    button.connect("clicked", _activate_from_button, window, action)
    return button


def _activate_from_button(_button, window, action) -> None:
    popover = getattr(window, "_context_popover", None)
    if popover is not None:
        popover.popdown()
    window.activate_action(action, None)
