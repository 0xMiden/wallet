package ee.forgr.capacitor_inappbrowser.navbar;

import android.util.Log;
import java.util.ArrayList;
import java.util.List;

/**
 * Miden patch — Android port of iOS MidenNavbarOverlayWindow.
 *
 * Single source of truth for the navbar's state. Every plugin method
 * call (showNativeNavbar, setNavbarAction, setNavbarSecondaryRow,
 * morphNavbarOut, etc) mutates the holder and broadcasts the new state
 * to all attached observers.
 *
 * Observer list is thread-safe: all mutations must happen on the UI
 * thread (the plugin entrypoints already enforce this via
 * {@code activity.runOnUiThread}), so the observer list itself is
 * iterated without locking.
 *
 * Lifecycle:
 *   - A single holder instance is owned by {@link NavbarOverlayManager}
 *     for the lifetime of the Capacitor Activity.
 *   - {@link NavbarView} instances subscribe on attach, unsubscribe on
 *     detach.
 *   - The Activity-scoped NavbarView is created once at plugin load;
 *     per-Dialog NavbarView instances are created on dialog show and
 *     destroyed on dialog dismiss.
 */
public final class NavbarStateHolder {

    private static final String TAG = "NavbarStateHolder";

    /** Observer callback. Fires on the UI thread with the new state. */
    public interface Observer {
        void onStateChanged(NavbarState state);
    }

    private NavbarState state = NavbarState.empty();
    private final List<Observer> observers = new ArrayList<>();

    /** Returns the current immutable state snapshot. */
    public synchronized NavbarState getState() {
        return state;
    }

    /**
     * Subscribe to state changes. Immediately delivers the current
     * state on subscription so new views can bind without waiting for
     * the next mutation.
     */
    public void addObserver(Observer observer) {
        observers.add(observer);
        // Synchronous initial delivery — simpler than a post() because
        // we're already on the UI thread when views attach.
        observer.onStateChanged(state);
    }

    public void removeObserver(Observer observer) {
        observers.remove(observer);
    }

    /**
     * Replace the current state and broadcast to all observers. The
     * caller is responsible for constructing the new state via the
     * {@code with...} helpers on {@link NavbarState}.
     */
    public void setState(NavbarState newState) {
        this.state = newState;
        // Copy the observer list before iterating so observers that
        // unsubscribe during their own callback (e.g. a view that
        // detaches mid-update) don't mutate the list we're iterating.
        List<Observer> snapshot = new ArrayList<>(observers);
        for (Observer o : snapshot) {
            try {
                o.onStateChanged(newState);
            } catch (Exception e) {
                Log.e(TAG, "observer threw during onStateChanged", e);
            }
        }
    }

    /** Convenience: observer count for tests and diagnostics. */
    public int observerCount() {
        return observers.size();
    }
}
