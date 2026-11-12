package ee.forgr.capacitor_inappbrowser;

import android.animation.ValueAnimator;
import android.graphics.Color;
import android.graphics.Outline;
import android.os.Build;
import android.os.Trace;
import android.view.View;
import android.view.ViewOutlineProvider;
import androidx.dynamicanimation.animation.FloatValueHolder;
import androidx.dynamicanimation.animation.SpringAnimation;
import androidx.dynamicanimation.animation.SpringForce;

final class BreadMorphController {
    interface Listener {
        void onFrame(float p);
        void onSettled(float end);
    }

    // p runs over 0..RANGE, so a minimum visible change of 1 is a hundredth of a percent of the path.
    private static final float RANGE = 10000;
    private static final int SHADOW = Color.rgb(15, 23, 42);

    private final View container;
    private final Listener listener;
    private final float density;
    private final SpringAnimation spring = new SpringAnimation(new FloatValueHolder(RANGE));
    private final BreadMorphGeometry.Pose pose = new BreadMorphGeometry.Pose();
    private final ViewOutlineProvider restOutline;
    private final float restElevation;
    private final int restSpotShadow;
    private final int restAmbientShadow;
    private final ViewOutlineProvider outline = new ViewOutlineProvider() {
        @Override public void getOutline(View view, Outline out) {
            out.setRoundRect(0, 0, Math.round(width), Math.round(pose.cropHeight), pose.radius);
        }
    };
    private BreadMorphCard card;
    private float width;
    private float height;
    private float target = 1;
    private float progress = 1;
    private float velocity;
    private boolean boosted;
    private int section;

    BreadMorphController(View container, Listener listener) {
        this.container = container;
        this.listener = listener;
        density = container.getResources().getDisplayMetrics().density;
        restOutline = container.getOutlineProvider();
        restElevation = container.getElevation();
        restSpotShadow = container.getOutlineSpotShadowColor();
        restAmbientShadow = container.getOutlineAmbientShadowColor();
        spring.setSpring(new SpringForce(RANGE));
        spring.setMinimumVisibleChange(1);
        spring.addUpdateListener((animation, value, rate) -> {
            progress = value / RANGE;
            velocity = rate / RANGE;
            apply(progress);
            listener.onFrame(progress);
        });
        spring.addEndListener((animation, canceled, value, rate) -> {
            if (!canceled) land(target);
        });
    }

    void animateTo(float to, BreadMorphCard landing, float velocityP, BreadMorphPhysics physics) {
        boolean running = spring.isRunning();
        // A retarget toward the slot keeps the card the flight left from; one toward a card lands on it.
        if (!running || to < 0.5f) card = landing;
        if (!running) measure();
        target = to;
        if (!ValueAnimator.areAnimatorsEnabled()) {
            BreadFrameBoost.release();
            spring.cancel();
            land(to);
            return;
        }
        boost();
        SpringForce force = spring.getSpring();
        force.setStiffness(physics.stiffness);
        force.setDampingRatio(physics.dampingRatio);
        // Not animateToFinalPosition: its queued target survives a cancel and steers the next flight.
        force.setFinalPosition(to * RANGE);
        if (running) return;
        spring.setStartValue(progress * RANGE);
        spring.setStartVelocity(velocityP * RANGE);
        spring.start();
    }

    void place(BreadMorphCard landing, float p) {
        spring.cancel();
        card = landing;
        measure();
        progress = p;
        velocity = 0;
        apply(p);
    }

    float progress() { return progress; }
    float velocity() { return spring.isRunning() ? velocity : 0; }
    float target() { return target; }
    BreadMorphCard card() { return card; }
    boolean running() { return spring.isRunning(); }

    float freeze() {
        spring.cancel();
        velocity = 0;
        return progress;
    }

    void track(float p) {
        spring.cancel();
        progress = p;
        velocity = 0;
        apply(p);
        listener.onFrame(p);
    }

    void prepareTracking(BreadMorphCard landing, float from, float to) {
        spring.cancel();
        card = landing;
        measure();
        target = to;
        progress = from;
        velocity = 0;
        boost();
        apply(from);
        listener.onFrame(from);
    }

    float finishAtNearestEnd() {
        float end = progress >= 0.5f ? 1 : 0;
        spring.cancel();
        target = end;
        land(end);
        return end;
    }

    void reset() {
        spring.cancel();
        card = null;
        target = 1;
        progress = 1;
        velocity = 0;
        container.setScaleX(1);
        container.setScaleY(1);
        container.setTranslationX(0);
        container.setTranslationY(0);
        container.setAlpha(1);
        container.setElevation(restElevation);
        container.setClipToOutline(false);
        container.setOutlineProvider(restOutline);
        container.setOutlineSpotShadowColor(restSpotShadow);
        container.setOutlineAmbientShadowColor(restAmbientShadow);
        idle();
    }

    private void land(float end) {
        progress = end;
        velocity = 0;
        apply(end);
        idle();
        listener.onSettled(end);
    }

    private void measure() {
        width = container.getWidth();
        height = container.getHeight();
    }

    private void apply(float p) {
        BreadMorphGeometry.pose(p, card, width, height, pose);
        container.setPivotX(0);
        container.setPivotY(0);
        container.setScaleX(pose.scale);
        container.setScaleY(pose.scale);
        container.setTranslationX(pose.translationX);
        container.setTranslationY(pose.translationY);
        container.setAlpha(pose.alpha);
        container.setElevation(pose.elevationDp * density);
        if (container.getOutlineProvider() != outline) {
            container.setOutlineProvider(outline);
            container.setOutlineSpotShadowColor(SHADOW);
            container.setOutlineAmbientShadowColor(SHADOW);
        }
        container.setClipToOutline(true);
        container.invalidateOutline();
        if (Build.VERSION.SDK_INT >= 29) Trace.setCounter("bread_morph_p", Math.round(p * RANGE));
        // Frame-rate votes are cast while views draw, and a property-only change draws nothing.
        if (Build.VERSION.SDK_INT >= 35 && boosted) container.invalidate();
    }

    private void boost() {
        if (boosted) return;
        boosted = true;
        if (Build.VERSION.SDK_INT >= 29) Trace.beginAsyncSection("bread_morph", ++section);
        if (Build.VERSION.SDK_INT >= 35) container.setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
        BreadFrameBoost.release();
    }

    private void idle() {
        if (!boosted) return;
        boosted = false;
        if (Build.VERSION.SDK_INT >= 29) Trace.endAsyncSection("bread_morph", section);
        if (Build.VERSION.SDK_INT >= 35) container.setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT);
    }
}
