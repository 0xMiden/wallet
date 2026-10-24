package ee.forgr.capacitor_inappbrowser;

import android.view.View;

final class BreadMorphController {
    interface Listener {
        void onFrame(float p);
        void onSettled(float end);
    }

    BreadMorphController(View container, Listener listener) { }

    void animateTo(float target, BreadMorphCard card, float velocityP, BreadMorphPhysics physics) { }
    float progress() { return 1; }
    float velocity() { return 0; }
    float freeze() { return 1; }
    void track(float p) { }
    void release(float velocityP) { }
    float finishAtNearestEnd() { return 1; }
    void reset() { }
    boolean running() { return false; }
}
