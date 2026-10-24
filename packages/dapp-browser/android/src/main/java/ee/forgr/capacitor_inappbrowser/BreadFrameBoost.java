package ee.forgr.capacitor_inappbrowser;

import android.os.Build;
import android.os.SystemClock;
import android.view.Choreographer;
import android.view.View;

// Holds the HIGH frame-rate category from a touch-down until a morph casts its own vote, or until it lapses.
final class BreadFrameBoost {
    static final long DURATION_MS = 600;
    private static final Choreographer.FrameCallback FRAME = nanos -> tick();
    private static View view;
    private static long until;

    private BreadFrameBoost() {}

    static void hold(View target, long millis) {
        if (Build.VERSION.SDK_INT < 35 || target == null) return;
        if (view != target) {
            release();
            view = target;
            target.setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
            Choreographer.getInstance().postFrameCallback(FRAME);
        }
        until = Math.max(until, SystemClock.uptimeMillis() + millis);
        target.invalidate();
    }

    static boolean active() { return view != null; }

    static void release() {
        View last = view;
        if (last == null) return;
        view = null;
        until = 0;
        Choreographer.getInstance().removeFrameCallback(FRAME);
        last.setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT);
    }

    private static void tick() {
        if (view == null) return;
        if (SystemClock.uptimeMillis() >= until) {
            release();
            return;
        }
        // A vote is cast only while the view draws.
        view.invalidate();
        Choreographer.getInstance().postFrameCallback(FRAME);
    }
}
