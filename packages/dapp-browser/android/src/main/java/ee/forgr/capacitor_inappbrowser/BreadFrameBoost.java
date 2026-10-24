package ee.forgr.capacitor_inappbrowser;

import android.view.View;

final class BreadFrameBoost {
    static final long DURATION_MS = 600;

    private BreadFrameBoost() {}

    static void hold(View target, long millis) {}

    static boolean active() { return false; }

    static void release() {}
}
