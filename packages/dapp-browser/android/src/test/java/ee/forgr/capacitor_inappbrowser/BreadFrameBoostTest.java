package ee.forgr.capacitor_inappbrowser;

import android.graphics.RectF;
import android.view.View;
import android.widget.FrameLayout;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class BreadFrameBoostTest {
    @Before public void setUp() throws Exception { BreadMorphControllerTest.resetSpringFrames(); }

    @After public void tearDown() { BreadFrameBoost.release(); }

    private static View view() { return spy(new View(RuntimeEnvironment.getApplication())); }

    @Test public void holdsTheHighCategoryAndRedrawsUntilItLapses() {
        View view = view();
        BreadFrameBoost.hold(view, 600);
        assertTrue(BreadFrameBoost.active());
        verify(view).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
        BreadMorphControllerTest.advance(400);
        verify(view, atLeast(10)).invalidate();
        verify(view, never()).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT);
        BreadFrameBoost.hold(view, 600);
        BreadMorphControllerTest.advance(400);
        assertTrue(BreadFrameBoost.active());
        verify(view, times(1)).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
        BreadMorphControllerTest.advance(300);
        assertFalse(BreadFrameBoost.active());
        verify(view).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT);
        clearInvocations(view);
        BreadMorphControllerTest.advance(100);
        verify(view, never()).invalidate();
    }

    @Test public void aMorphTakesTheBoostOver() {
        View touched = view();
        FrameLayout container = spy(new FrameLayout(RuntimeEnvironment.getApplication()));
        container.measure(View.MeasureSpec.makeMeasureSpec(1206, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(2259, View.MeasureSpec.EXACTLY));
        container.layout(0, 0, 1206, 2259);
        BreadMorphController morph = new BreadMorphController(container, new BreadMorphController.Listener() {
            @Override public void onFrame(float p) {}
            @Override public void onSettled(float end) {}
        });
        BreadFrameBoost.hold(touched, 600);
        morph.animateTo(0, new BreadMorphCard(new RectF(846, 1950, 1158, 2346), 48), 0, BreadMorphPhysics.COLLAPSE);
        verify(container).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
        assertFalse(BreadFrameBoost.active());
        verify(touched).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT);
        morph.reset();
    }

    @Test public void anotherViewTakesTheVoteOver() {
        View first = view(), second = view();
        BreadFrameBoost.hold(first, 600);
        BreadFrameBoost.hold(second, 600);
        verify(first).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT);
        verify(second).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
        assertTrue(BreadFrameBoost.active());
    }

    @Test @Config(sdk = 34)
    public void requestsNothingBelowApi35() {
        View view = view();
        BreadFrameBoost.hold(view, 600);
        assertFalse(BreadFrameBoost.active());
        BreadMorphControllerTest.advance(100);
        verify(view, never()).invalidate();
    }
}
