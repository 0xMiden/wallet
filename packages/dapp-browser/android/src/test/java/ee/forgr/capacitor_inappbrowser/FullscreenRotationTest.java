package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.app.Dialog;
import android.view.Window;
import android.view.WindowManager;
import java.lang.ref.Reference;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class FullscreenRotationTest {
    private Activity activity;
    private org.robolectric.android.controller.ActivityController<Activity> activityController;
    private Window window;
    private final List<FullscreenRotation> owners = new ArrayList<>();

    @Before public void setUp() {
        activityController = Robolectric.buildActivity(Activity.class).create();
        activity = activityController.get();
        window = activity.getWindow();
    }

    @After public void tearDown() {
        owners.forEach(FullscreenRotation::release);
        activityController.destroy();
    }

    private FullscreenRotation owner() {
        FullscreenRotation owner = new FullscreenRotation();
        owners.add(owner);
        return owner;
    }

    private void hint(Window target, int hint) {
        WindowManager.LayoutParams params = target.getAttributes();
        params.rotationAnimation = hint;
        target.setAttributes(params);
    }

    @Test public void jumpcutChangesOnlyTheCurrentRotationField() {
        hint(window, 0);
        WindowManager.LayoutParams before = new WindowManager.LayoutParams();
        before.copyFrom(window.getAttributes());
        FullscreenRotation owner = owner();
        owner.acquire(window);
        assertEquals(2, window.getAttributes().rotationAnimation);
        WindowManager.LayoutParams after = new WindowManager.LayoutParams();
        after.copyFrom(window.getAttributes());
        after.rotationAnimation = 0;
        assertEquals(0, after.copyFrom(before));
        window.getAttributes().screenBrightness = 0.4f;
        owner.release();
        assertEquals(0, window.getAttributes().rotationAnimation);
        assertEquals(0.4f, window.getAttributes().screenBrightness, 0);
    }

    @Test public void lastOwnerRestoresEachNondefaultPriorHint() {
        for (int original : new int[] {1, 3}) {
            hint(window, original);
            FullscreenRotation owner = owner();
            owner.acquire(window);
            assertEquals(2, window.getAttributes().rotationAnimation);
            owner.release();
            assertEquals(original, window.getAttributes().rotationAnimation);
        }
    }

    @Test public void repeatedAcquireAndReleaseDoNotRewriteAttributes() {
        hint(window, 1);
        Window observed = spy(window);
        FullscreenRotation owner = owner();
        owner.acquire(observed); owner.acquire(observed);
        verify(observed, times(1)).setAttributes(any());
        assertEquals(2, observed.getAttributes().rotationAnimation);
        owner.release(); owner.release();
        verify(observed, times(2)).setAttributes(any());
        assertEquals(1, observed.getAttributes().rotationAnimation);
    }

    @Test public void existingJumpcutDoesNotWriteAttributes() {
        hint(window, 2);
        Window observed = spy(window);
        FullscreenRotation owner = owner();
        owner.acquire(observed); owner.release();
        verify(observed, never()).setAttributes(any());
        assertEquals(2, observed.getAttributes().rotationAnimation);
    }

    @Test public void overlappingOwnersRetainPolicyInBothReleaseOrders() {
        for (boolean firstFirst : new boolean[] {true, false}) {
            hint(window, 3);
            FullscreenRotation first = owner(), second = owner();
            first.acquire(window); second.acquire(window);
            FullscreenRotation early = firstFirst ? first : second;
            FullscreenRotation last = firstFirst ? second : first;
            early.release(); early.release();
            assertEquals(2, window.getAttributes().rotationAnimation);
            last.release();
            assertEquals(3, window.getAttributes().rotationAnimation);
        }
    }

    @Test public void nullWindowReleasesThePreviousWindow() {
        hint(window, 1);
        FullscreenRotation owner = owner();
        owner.acquire(null); owner.release(); owner.acquire(window);
        assertEquals(2, window.getAttributes().rotationAnimation);
        owner.acquire(null); owner.release();
        assertEquals(1, window.getAttributes().rotationAnimation);
    }

    @Test public void switchingWindowsRestoresTheOldWindowFirst() {
        Window next = new Dialog(activity).getWindow();
        hint(window, 1); hint(next, 3);
        FullscreenRotation owner = owner();
        owner.acquire(window); owner.acquire(next);
        assertEquals(1, window.getAttributes().rotationAnimation);
        assertEquals(2, next.getAttributes().rotationAnimation);
        owner.release();
        assertEquals(3, next.getAttributes().rotationAnimation);
    }

    @Test public void externalHintSurvivesRepeatedAcquireAndFinalRelease() {
        hint(window, 0);
        FullscreenRotation owner = owner();
        owner.acquire(window);
        hint(window, 3);
        owner.acquire(window); owner.release();
        assertEquals(3, window.getAttributes().rotationAnimation);
    }

    @Test public void externalHintSurvivesAnotherOwnerJoiningTheLease() {
        hint(window, 0);
        FullscreenRotation first = owner(), second = owner();
        first.acquire(window);
        hint(window, 1);
        second.acquire(window); first.release();
        assertEquals(1, window.getAttributes().rotationAnimation);
        second.release();
        assertEquals(1, window.getAttributes().rotationAnimation);
    }

    private WeakReference<Window> detachedWindow(FullscreenRotation owner) {
        Window detached = new Dialog(activity).getWindow();
        owner.acquire(detached);
        return new WeakReference<>(detached);
    }

    private void collected(WeakReference<?> reference) {
        for (int attempt = 0; attempt < 20 && reference.get() != null; attempt++) {
            System.gc(); System.runFinalization();
        }
        assertNull("Rotation ownership must not retain detached windows or owners", reference.get());
    }

    @Test public void collectedWindowCanBeReleasedAndReplaced() {
        FullscreenRotation owner = owner();
        WeakReference<Window> detached = detachedWindow(owner);
        collected(detached);
        owner.release();
        hint(window, 1);
        owner.acquire(window);
        assertEquals(2, window.getAttributes().rotationAnimation);
        owner.release();
        assertEquals(1, window.getAttributes().rotationAnimation);
    }

    private WeakReference<FullscreenRotation> temporaryOwner() {
        FullscreenRotation temporary = new FullscreenRotation();
        temporary.acquire(window);
        return new WeakReference<>(temporary);
    }

    @Test public void collectedOwnerDoesNotLoseTheOriginalPolicyOnTakeover() {
        hint(window, 3);
        WeakReference<FullscreenRotation> temporary = temporaryOwner();
        assertEquals(2, window.getAttributes().rotationAnimation);
        collected(temporary);
        FullscreenRotation replacement = owner();
        replacement.acquire(window); replacement.release();
        assertEquals(3, window.getAttributes().rotationAnimation);
    }

    private void clearOwnerBeforeQueueCleanup(FullscreenRotation owner) throws Exception {
        Field policiesField = FullscreenRotation.class.getDeclaredField("policies");
        policiesField.setAccessible(true);
        Object policy = ((Map<?, ?>) policiesField.get(null)).get(window);
        Field ownersField = policy.getClass().getDeclaredField("owners");
        ownersField.setAccessible(true);
        Map<?, ?> retainedOwners = (Map<?, ?>) ownersField.get(policy);
        for (Map.Entry<?, ?> entry : retainedOwners.entrySet()) {
            if (entry.getKey() == owner) {
                // Clear the weak key without adding it to the reference queue.
                ((Reference<?>) entry).clear();
                return;
            }
        }
        fail("Rotation owner not found");
    }

    @Test public void clearedOwnerDoesNotLoseTheOriginalPolicyBeforeQueueCleanup() throws Exception {
        hint(window, 3);
        FullscreenRotation temporary = owner();
        temporary.acquire(window);
        clearOwnerBeforeQueueCleanup(temporary);
        FullscreenRotation replacement = owner();
        replacement.acquire(window); replacement.release();
        assertEquals(3, window.getAttributes().rotationAnimation);
    }

    @Test public void clearedOwnerDoesNotPreventFinalReleaseBeforeQueueCleanup() throws Exception {
        hint(window, 3);
        FullscreenRotation temporary = owner(), retained = owner();
        temporary.acquire(window); retained.acquire(window);
        clearOwnerBeforeQueueCleanup(temporary);
        retained.release();
        assertEquals(3, window.getAttributes().rotationAnimation);
    }
}
