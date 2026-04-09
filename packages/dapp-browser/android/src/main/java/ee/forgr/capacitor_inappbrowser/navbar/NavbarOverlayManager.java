package ee.forgr.capacitor_inappbrowser.navbar;

import android.app.Activity;
import android.app.Dialog;
import android.util.Log;
import android.view.ViewGroup;
import java.util.ArrayList;
import java.util.List;

/**
 * Miden patch — Android port of iOS MidenNavbarOverlayWindow.
 *
 * Coordinates navbar view instances across the Activity and any
 * currently-showing {@code WebViewDialog}s, and exposes a single API
 * surface for the Capacitor plugin to mutate state.
 *
 * Architecture (the decision Phase 0 validated):
 *   - One {@link NavbarStateHolder} owns the complete navbar state.
 *   - The Activity has one {@link NavbarView} instance attached to
 *     its decor view.
 *   - Every {@code WebViewDialog} gets its own {@link NavbarView}
 *     instance attached to its decor view at show-time. On dismiss
 *     the instance is detached and garbage-collected.
 *   - At any moment, at most one instance is VISIBLE: the Activity
 *     instance when no Dialog is foreground, or the top Dialog
 *     instance when one is. The manager toggles
 *     {@code view.setVisibility()} to pick.
 *   - All instances subscribe to the same state holder so a single
 *     plugin mutation propagates to whichever instance is visible.
 *
 * Why two-instance instead of re-parenting one view: Android's
 * Window stacking places a Dialog's Window above its parent
 * Activity's Window, so a view attached to the Activity decor view
 * is invisible behind the Dialog. A view attached to the Dialog
 * decor view is composited inside the Dialog's Window — which is
 * what we need. We can't have one View in two ViewGroups
 * simultaneously, and moving it mid-animation risks flicker, so we
 * keep two instances and only show one.
 */
public final class NavbarOverlayManager {

    private static final String TAG = "NavbarOverlayManager";

    private final Activity activity;
    private final NavbarStateHolder stateHolder;

    /**
     * The Activity-scoped NavbarView instance, attached to the
     * Activity's decor view for the lifetime of the plugin. Created
     * lazily on first {@code showNativeNavbar} call.
     */
    private NavbarView activityView;

    /**
     * Stack of currently-shown Dialog instances (most recent on top).
     * Each entry is the NavbarView attached to that Dialog's decor
     * view. We use a list rather than a single reference because in
     * theory multiple dApps could be foreground at once (nested
     * Dialogs), though in practice the wallet shows one at a time.
     */
    private final List<DialogEntry> dialogStack = new ArrayList<>();

    private static final class DialogEntry {

        final Dialog dialog;
        final NavbarView view;

        DialogEntry(Dialog dialog, NavbarView view) {
            this.dialog = dialog;
            this.view = view;
        }
    }

    public NavbarOverlayManager(Activity activity) {
        this.activity = activity;
        this.stateHolder = new NavbarStateHolder();
    }

    public NavbarStateHolder getStateHolder() {
        return stateHolder;
    }

    // ─── Activity-scoped view lifecycle ────────────────────────────────

    /**
     * Ensure the Activity-scoped NavbarView is created and attached to
     * the Activity's decor view. Called lazily the first time a
     * {@code showNativeNavbar} plugin method call arrives. Idempotent.
     */
    public void ensureActivityViewCreated() {
        if (activityView != null) return;
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        activityView = new NavbarView(activity, stateHolder);
        activityView.attachManager(this);
        decor.addView(activityView, NavbarView.floatingBottomLayoutParams());
        Log.d(TAG, "activity view created and attached");
        refreshVisibility();
    }

    /**
     * Detach and destroy every NavbarView instance tracked by this
     * manager — the Activity-scoped one AND any lingering
     * Dialog-scoped ones. Called when the plugin is being shut
     * down (e.g. Activity destroy), so the state holder has zero
     * observers left and all View references are released for GC.
     */
    public void destroyActivityView() {
        // Tear down any Dialog-scoped instances first so the
        // `dialogStack` is empty when we touch the activity view.
        for (DialogEntry entry : dialogStack) {
            ViewGroup parent = (ViewGroup) entry.view.getParent();
            if (parent != null) parent.removeView(entry.view);
            entry.view.onDetachedFromManager();
        }
        dialogStack.clear();

        if (activityView != null) {
            ViewGroup parent = (ViewGroup) activityView.getParent();
            if (parent != null) parent.removeView(activityView);
            activityView.onDetachedFromManager();
            activityView = null;
        }
        Log.d(TAG, "manager destroyed (observers=" + stateHolder.observerCount() + ")");
    }

    // ─── Dialog-scoped view lifecycle ──────────────────────────────────

    /**
     * Attach a fresh NavbarView to a WebViewDialog's decor view.
     * Called from an {@code OnShowListener} registered on every
     * WebViewDialog in {@code InAppBrowserPlugin.openWebView()}.
     *
     * After attach, the dialog instance becomes the visible one and
     * the activity instance is hidden.
     */
    public void onDialogShown(Dialog dialog) {
        if (dialog.getWindow() == null) {
            Log.w(TAG, "onDialogShown: dialog has no window — skipping");
            return;
        }
        ViewGroup decor = (ViewGroup) dialog.getWindow().getDecorView();
        NavbarView dialogView = new NavbarView(activity, stateHolder);
        dialogView.attachManager(this);
        decor.addView(dialogView, NavbarView.floatingBottomLayoutParams());
        dialogStack.add(new DialogEntry(dialog, dialogView));
        Log.d(TAG, "dialog view attached (stack size=" + dialogStack.size() + ")");
        refreshVisibility();
    }

    /**
     * Called after {@code Dialog.hide()} or {@code Dialog.show()} is
     * invoked by the plugin's setVisible handler. Re-runs the
     * visibility arbitration so the right NavbarView instance takes
     * over. Needed because Android's Dialog class has no OnHide
     * callback — we have to plumb this through the plugin manually.
     */
    public void notifyDialogVisibilityChanged(Dialog dialog) {
        refreshVisibility();
    }

    /**
     * Detach the NavbarView from a WebViewDialog that's being
     * dismissed. Called from an {@code OnDismissListener} registered
     * on every WebViewDialog.
     */
    public void onDialogDismissed(Dialog dialog) {
        DialogEntry toRemove = null;
        for (DialogEntry entry : dialogStack) {
            if (entry.dialog == dialog) {
                toRemove = entry;
                break;
            }
        }
        if (toRemove == null) {
            Log.w(TAG, "onDialogDismissed: dialog not in stack — no-op");
            return;
        }
        dialogStack.remove(toRemove);
        ViewGroup parent = (ViewGroup) toRemove.view.getParent();
        if (parent != null) parent.removeView(toRemove.view);
        toRemove.view.onDetachedFromManager();
        Log.d(TAG, "dialog view detached (stack size=" + dialogStack.size() + ")");
        refreshVisibility();
    }

    // ─── Visibility arbitration ───────────────────────────────────────

    /**
     * Decide which of the active NavbarView instances should be
     * visible and which should be hidden. Called whenever the stack
     * changes (dialog shown/dismissed/hidden/shown-again) or the
     * state toggles visible.
     *
     * Rule: the topmost CURRENTLY-SHOWING view in the stack wins.
     * A Dialog that's been hidden via {@code Dialog.hide()} (our
     * {@code setVisible(false)} plugin method) still has its
     * NavbarView attached to the Dialog's decor view, but the
     * Dialog Window is detached from the screen — so the Dialog
     * NavbarView is not actually visible. We skip hidden Dialogs
     * when picking the top so the Activity NavbarView takes over,
     * which IS visible.
     *
     * Without this filter, parking a dApp makes the navbar
     * disappear entirely: the Activity view is hidden (because
     * a Dialog is still "top" by insertion order) AND the Dialog
     * view is invisible (because the Dialog itself is hidden).
     */
    private void refreshVisibility() {
        NavbarView top = null;
        // Walk the Dialog stack from most-recent to oldest and pick
        // the first one whose Dialog is currently showing.
        for (int i = dialogStack.size() - 1; i >= 0; i--) {
            DialogEntry entry = dialogStack.get(i);
            if (entry.dialog.isShowing()) {
                top = entry.view;
                break;
            }
        }
        // No showing Dialog → fall back to the Activity instance.
        if (top == null && activityView != null) {
            top = activityView;
        }
        // Hide all non-top views.
        if (activityView != null && activityView != top) {
            activityView.setFloatingVisible(false);
        }
        for (DialogEntry entry : dialogStack) {
            if (entry.view != top) {
                entry.view.setFloatingVisible(false);
            }
        }
        // Show the top view, gated on global state.visible.
        if (top != null) {
            top.setFloatingVisible(stateHolder.getState().visible);
        }
    }

    // ─── State mutation helpers (called by plugin methods) ────────────

    /**
     * Set the navbar items and global visible flag. If the Activity
     * view hasn't been created yet, creates it now.
     */
    public void show(List<NavbarState.Item> items, String activeId) {
        ensureActivityViewCreated();
        NavbarState newState = stateHolder.getState().withItems(items, activeId).withVisible(true);
        stateHolder.setState(newState);
        refreshVisibility();
    }

    public void hide() {
        NavbarState newState = stateHolder.getState().withVisible(false);
        stateHolder.setState(newState);
        refreshVisibility();
    }

    public void setActive(String activeId) {
        NavbarState newState = stateHolder.getState().withActiveId(activeId);
        stateHolder.setState(newState);
    }

    public void setSecondaryItems(List<NavbarState.Item> items, String activeId) {
        NavbarState newState = stateHolder.getState().withSecondary(items, activeId);
        stateHolder.setState(newState);
    }

    public void setAction(String label, boolean enabled) {
        NavbarState newState = stateHolder.getState().withAction(new NavbarState.Action(label, enabled));
        stateHolder.setState(newState);
    }

    public void clearAction() {
        NavbarState newState = stateHolder.getState().withAction(null);
        stateHolder.setState(newState);
    }

    public void morphOut() {
        NavbarState newState = stateHolder.getState().withMorphedOut(true);
        stateHolder.setState(newState);
    }

    public void morphIn() {
        NavbarState newState = stateHolder.getState().withMorphedOut(false);
        stateHolder.setState(newState);
    }

    // ─── Event forwarding from views to the plugin ────────────────────

    /** Callbacks wired by the plugin to forward taps to JS. */
    public interface TapCallback {
        void onItemTap(String id);
        void onSecondaryTap(String id);
        void onActionTap();
    }

    private TapCallback tapCallback;

    public void setTapCallback(TapCallback callback) {
        this.tapCallback = callback;
    }

    // Called by NavbarView on button tap.
    void dispatchItemTap(String id) {
        if (tapCallback != null) tapCallback.onItemTap(id);
    }

    void dispatchSecondaryTap(String id) {
        if (tapCallback != null) tapCallback.onSecondaryTap(id);
    }

    void dispatchActionTap() {
        if (tapCallback != null) tapCallback.onActionTap();
    }
}
