package ee.forgr.capacitor_inappbrowser.navbar;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Miden patch — Android port of iOS MidenNavbarOverlayWindow.
 *
 * Immutable snapshot of the navbar's complete visual state. Held by
 * {@link NavbarStateHolder} and broadcast to every attached
 * {@link NavbarView} via observer callbacks. Every state change
 * produces a fresh {@code NavbarState} so observers can diff and
 * rebind without worrying about mutable shared state.
 *
 * Mirrors the iOS state-driving pattern in
 * {@code MidenNavbarOverlayWindow} — both platforms derive their
 * entire visible UI from the JS-provided items + activeId + action
 * state.
 */
public final class NavbarState {

    /** Single nav button descriptor (Home, Send, Continue, etc). */
    public static final class Item {

        public final String id;
        public final String title;
        public final String iconDrawableName; // resource name (e.g. "nav_home"), resolved at bind time

        public Item(String id, String title, String iconDrawableName) {
            this.id = id;
            this.title = title;
            this.iconDrawableName = iconDrawableName;
        }
    }

    /** Compact-mode primary action button state (e.g. "Continue"). */
    public static final class Action {

        public final String label;
        public final boolean enabled;

        public Action(String label, boolean enabled) {
            this.label = label;
            this.enabled = enabled;
        }
    }

    /** Global visibility: when false the navbar is not rendered at all. */
    public final boolean visible;

    /** Morphed-out state: when true the navbar slides off-screen via animation. */
    public final boolean morphedOut;

    /** Main-row items (typically Home / Activity / Browser). */
    public final List<Item> items;

    /** Id of the currently-highlighted main-row item, or null for no highlight. */
    public final String activeId;

    /** Secondary-row items (Send / Receive / Settings). Empty list = row collapsed. */
    public final List<Item> secondaryItems;

    /** Id of the currently-highlighted secondary-row item, or null for no highlight. */
    public final String secondaryActiveId;

    /** Compact-mode action state, or null when no action button is shown. */
    public final Action action;

    public NavbarState(
        boolean visible,
        boolean morphedOut,
        List<Item> items,
        String activeId,
        List<Item> secondaryItems,
        String secondaryActiveId,
        Action action
    ) {
        this.visible = visible;
        this.morphedOut = morphedOut;
        this.items = items == null ? Collections.emptyList() : Collections.unmodifiableList(new ArrayList<>(items));
        this.activeId = activeId;
        this.secondaryItems = secondaryItems == null
            ? Collections.emptyList()
            : Collections.unmodifiableList(new ArrayList<>(secondaryItems));
        this.secondaryActiveId = secondaryActiveId;
        this.action = action;
    }

    /** Initial "hidden, no items" state. */
    public static NavbarState empty() {
        return new NavbarState(false, false, null, null, null, null, null);
    }

    /** Returns a copy with the given {@code visible} flag flipped. */
    public NavbarState withVisible(boolean newVisible) {
        return new NavbarState(newVisible, morphedOut, items, activeId, secondaryItems, secondaryActiveId, action);
    }

    /** Returns a copy with the given {@code morphedOut} flag flipped. */
    public NavbarState withMorphedOut(boolean newMorphedOut) {
        return new NavbarState(visible, newMorphedOut, items, activeId, secondaryItems, secondaryActiveId, action);
    }

    /** Returns a copy with a new main-row items list and active id. */
    public NavbarState withItems(List<Item> newItems, String newActiveId) {
        return new NavbarState(visible, morphedOut, newItems, newActiveId, secondaryItems, secondaryActiveId, action);
    }

    /** Returns a copy with a new main-row active id only. */
    public NavbarState withActiveId(String newActiveId) {
        return new NavbarState(visible, morphedOut, items, newActiveId, secondaryItems, secondaryActiveId, action);
    }

    /** Returns a copy with a new secondary-row items list and active id. */
    public NavbarState withSecondary(List<Item> newSecondaryItems, String newSecondaryActiveId) {
        return new NavbarState(
            visible,
            morphedOut,
            items,
            activeId,
            newSecondaryItems,
            newSecondaryActiveId,
            action
        );
    }

    /** Returns a copy with a new action state (or null to clear). */
    public NavbarState withAction(Action newAction) {
        return new NavbarState(visible, morphedOut, items, activeId, secondaryItems, secondaryActiveId, newAction);
    }
}
