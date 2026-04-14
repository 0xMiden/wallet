package ee.forgr.capacitor_inappbrowser.navbar;

import android.util.Log;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

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

    private volatile NavbarState state = NavbarState.empty();
    // CopyOnWriteArrayList so add/remove/iterate can interleave
    // safely. Most mutations run on the UI thread, but
    // onDetachedFromWindow can fire from non-main paths under
    // framework-level Activity destruction (low-memory kill, monkey
    // runs) — the previous plain ArrayList + "UI thread only" comment
    // was a latent ConcurrentModificationException.
    private final List<Observer> observers = new CopyOnWriteArrayList<>();

    /** Returns the current immutable state snapshot. */
    public NavbarState getState() {
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
        // CopyOnWriteArrayList provides a consistent iterator across
        // concurrent add/remove, so we can iterate directly.
        for (Observer o : observers) {
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
