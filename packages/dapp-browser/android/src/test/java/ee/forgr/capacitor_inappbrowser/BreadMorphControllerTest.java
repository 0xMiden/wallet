package ee.forgr.capacitor_inappbrowser;

import android.animation.ValueAnimator;
import android.graphics.RectF;
import android.os.Looper;
import android.view.View;
import android.widget.FrameLayout;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowChoreographer;
import org.robolectric.shadows.ShadowTrace;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BreadMorphControllerTest {
    private static final int WIDTH = 1206;
    private static final int HEIGHT = 2259;
    private final List<Float> frames = new ArrayList<>();
    private final List<Float> settled = new ArrayList<>();
    private FrameLayout container;
    private View page;
    private BreadMorphController controller;

    // An unpaused Choreographer advances the clock and runs each vsync as soon as it is requested.
    static void resetSpringFrames() throws Exception {
        ShadowChoreographer.setPaused(true);
        ThreadLocal<?> handler = ReflectionHelpers.getStaticField(
            Class.forName("androidx.dynamicanimation.animation.AnimationHandler"), "sAnimatorHandler");
        handler.remove();
    }

    static void frame() { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16)); }
    static void settle() { advance(3000); }

    // A paused Choreographer delivers one vsync per clock step, so time moves a frame at a time.
    static void advance(long millis) { for (long t = 0; t < millis; t += 16) frame(); }

    @Before public void setUp() throws Exception {
        resetSpringFrames();
        container = new FrameLayout(RuntimeEnvironment.getApplication());
        page = new View(RuntimeEnvironment.getApplication());
        container.addView(page, new FrameLayout.LayoutParams(-1, -1));
        container.measure(View.MeasureSpec.makeMeasureSpec(WIDTH, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(HEIGHT, View.MeasureSpec.EXACTLY));
        container.layout(0, 0, WIDTH, HEIGHT);
        controller = new BreadMorphController(container, listener());
    }

    @After public void tearDown() {
        controller.reset();
        frame();
    }

    private BreadMorphController.Listener listener() {
        return new BreadMorphController.Listener() {
            @Override public void onFrame(float p) { frames.add(p); }
            @Override public void onSettled(float end) { settled.add(end); }
        };
    }

    private static BreadMorphCard card() { return new BreadMorphCard(new RectF(846, 1950, 1158, 2346), 48); }

    private float second(int i) { return frames.get(i) - 2 * frames.get(i - 1) + frames.get(i - 2); }

    @Test public void writesOnlyRenderNodePropertiesEachFrame() {
        controller.animateTo(0, card(), 0, BreadMorphPhysics.COLLAPSE);
        assertTrue(controller.running());
        for (int i = 0; i < 12; i++) {
            frame();
            assertFalse(container.isLayoutRequested());
            assertFalse(page.isLayoutRequested());
            assertEquals(WIDTH, page.getWidth());
            assertEquals(HEIGHT, page.getHeight());
            assertEquals(0, container.getPivotX(), 0);
            assertEquals(0, container.getPivotY(), 0);
            assertEquals(container.getScaleX(), container.getScaleY(), 0);
            assertTrue(container.getClipToOutline());
        }
        assertTrue(frames.size() >= 10);
        assertTrue(container.getScaleX() < 1);
        assertTrue(container.getTranslationX() > 0);
        assertTrue(container.getElevation() > 0);
        assertEquals(frames.get(frames.size() - 1), controller.progress(), 0);
        assertTrue(controller.velocity() < 0);
    }

    @Test public void retargetKeepsValueAndVelocityContinuous() {
        controller.animateTo(0, card(), 0, BreadMorphPhysics.COLLAPSE);
        for (int i = 0; i < 10; i++) frame();
        int retarget = frames.size();
        assertTrue(retarget >= 9);
        float velocity = controller.velocity();
        assertTrue(velocity < 0);
        controller.animateTo(1, card(), 0, BreadMorphPhysics.EXPAND);
        assertEquals(velocity, controller.velocity(), 0);
        for (int i = 0; i < 40; i++) frame();
        float before = frames.get(retarget - 1) - frames.get(retarget - 2);
        float after = frames.get(retarget) - frames.get(retarget - 1);
        assertTrue(before < 0);
        assertTrue(after < 0);
        assertTrue(Math.abs(after) <= 1.2f * Math.abs(before));
        float largest = 0;
        for (int i = 2; i < retarget; i++) largest = Math.max(largest, Math.abs(second(i)));
        assertTrue(Math.abs(second(retarget)) <= 3 * largest);
        assertTrue(frames.get(frames.size() - 1) > frames.get(retarget));
        settle();
        assertEquals(List.of(1f), settled);
        assertEquals(1, container.getScaleX(), 0);
    }

    @Test @Config(sdk = 35)
    public void requestsHighFrameRateWhileMovingAndResetsAtSettle() {
        FrameLayout moving = spy(container);
        controller = new BreadMorphController(moving, listener());
        controller.animateTo(0, card(), 0, BreadMorphPhysics.COLLAPSE);
        verify(moving).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
        frame();
        verify(moving, never()).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT);
        settle();
        assertEquals(List.of(0f), settled);
        verify(moving).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT);
    }

    @Test public void snapsWhenAnimatorsAreDisabled() {
        ReflectionHelpers.callStaticMethod(ValueAnimator.class, "setDurationScale",
            ReflectionHelpers.ClassParameter.from(float.class, 0f));
        try {
            controller.animateTo(0, card(), 0, BreadMorphPhysics.COLLAPSE);
            assertEquals(List.of(0f), settled);
            assertFalse(controller.running());
            assertEquals(0, controller.progress(), 0);
            assertEquals(312f / WIDTH, container.getScaleX(), 1e-4f);
            assertEquals(846, container.getTranslationX(), 0.05f);
        } finally {
            ReflectionHelpers.callStaticMethod(ValueAnimator.class, "setDurationScale",
                ReflectionHelpers.ClassParameter.from(float.class, 1f));
        }
    }

    @Test public void missingCardCollapsesWithFadeScale() {
        controller.animateTo(0, null, 0, BreadMorphPhysics.COLLAPSE);
        settle();
        assertEquals(List.of(0f), settled);
        assertEquals(0.9f, container.getScaleX(), 1e-4f);
        assertEquals(0, container.getAlpha(), 1e-4f);
        assertEquals(0.05f * WIDTH, container.getTranslationX(), 0.05f);
        assertEquals(0.05f * HEIGHT, container.getTranslationY(), 0.05f);
    }

    @Test public void finishAtNearestEndSnapsAndReportsIt() {
        controller.animateTo(0, card(), 0, BreadMorphPhysics.COLLAPSE);
        frame();
        frame();
        assertTrue(controller.running());
        assertTrue(controller.progress() > 0.5f);
        assertEquals(1, controller.finishAtNearestEnd(), 0);
        assertEquals(List.of(1f), settled);
        assertFalse(controller.running());
        assertEquals(1, container.getScaleX(), 0);
        assertEquals(0, container.getTranslationY(), 0);
        controller.animateTo(0, card(), 0, BreadMorphPhysics.COLLAPSE);
        for (int i = 0; i < 60 && controller.progress() >= 0.5f; i++) frame();
        assertTrue(controller.progress() < 0.5f);
        assertEquals(0, controller.finishAtNearestEnd(), 0);
        assertEquals(List.of(1f, 0f), settled);
        assertEquals(312f / WIDTH, container.getScaleX(), 1e-4f);
        settle();
        assertEquals(List.of(1f, 0f), settled);
    }

    @Test public void freezeTrackAndReleaseHoldThePoseThenSpring() {
        controller.animateTo(0, card(), 0, BreadMorphPhysics.COLLAPSE);
        for (int i = 0; i < 6; i++) frame();
        assertTrue(controller.running());
        float held = controller.freeze();
        assertFalse(controller.running());
        assertEquals(held, controller.progress(), 0);
        assertEquals(0, controller.velocity(), 0);
        frame();
        assertEquals(held, controller.progress(), 0);
        controller.track(0.25f);
        assertEquals(0.25f, controller.progress(), 0);
        assertEquals(BreadMorphGeometry.pose(0.25f, card(), WIDTH, HEIGHT).scale, container.getScaleX(), 1e-5f);
        controller.animateTo(0, controller.card(), -2, BreadMorphPhysics.RELEASE);
        assertTrue(controller.running());
        frame();
        frame();
        assertTrue(controller.progress() < 0.25f);
        settle();
        assertEquals(List.of(0f), settled);
    }

    @Test public void traceCountersRecordProgressWhileMoving() {
        controller.animateTo(0, card(), 0, BreadMorphPhysics.COLLAPSE);
        settle();
        List<Long> values = new ArrayList<>();
        for (ShadowTrace.Counter counter : ShadowTrace.getCounters()) {
            if ("bread_morph_p".equals(counter.getName())) values.add(counter.getValue());
        }
        assertTrue(values.size() > 5);
        assertEquals(Long.valueOf(0), values.get(values.size() - 1));
        int sections = 0;
        for (ShadowTrace.AsyncTraceSection section : ShadowTrace.getPreviousAsyncSections()) {
            if ("bread_morph".equals(section.getSectionName())) sections++;
        }
        assertEquals(1, sections);
        for (ShadowTrace.AsyncTraceSection section : ShadowTrace.getCurrentAsyncSections()) {
            assertNotEquals("bread_morph", section.getSectionName());
        }
    }

    @Test @Config(sdk = 28)
    public void traceCountersAreSkippedOnApi28() {
        controller.animateTo(0, card(), 0, BreadMorphPhysics.COLLAPSE);
        settle();
        assertEquals(List.of(0f), settled);
        assertTrue(ShadowTrace.getCounters().isEmpty());
    }
}
