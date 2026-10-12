package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.graphics.Insets;
import android.graphics.Rect;
import android.view.DisplayCutout;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.WebView;
import android.widget.FrameLayout;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class HostReturnInsetsTest {
    private WebView host;
    private FrameLayout parent;
    private final AtomicInteger changes = new AtomicInteger();

    @Before public void setUp() {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().visible().get();
        parent = new FrameLayout(activity);
        host = spy(new WebView(activity));
        parent.addView(host, new ViewGroup.LayoutParams(390, 844));
        activity.setContentView(parent);
    }

    private WindowInsets insets(boolean visible, int bottom) {
        Insets ordinary = Insets.of(0, 52, 0, bottom);
        return new WindowInsets.Builder()
            .setInsets(WindowInsets.Type.systemBars(), visible ? ordinary : Insets.NONE)
            .setInsetsIgnoringVisibility(WindowInsets.Type.systemBars(), ordinary)
            .setVisible(WindowInsets.Type.systemBars(), visible)
            .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, 280))
            .setVisible(WindowInsets.Type.ime(), true)
            .setInsets(WindowInsets.Type.systemGestures(), Insets.of(7, 0, 7, 19))
            .setDisplayCutout(new DisplayCutout(Insets.of(0, 9, 0, 0), null, new Rect(100, 0, 120, 9), null, null))
            .build();
    }

    @Test public void delegatesOnlyAdaptedBarsBeforeAnnouncingReadinessAndPreservesOtherMaps() {
        WindowInsets incoming = insets(false, 24);
        HostReturnInsets policy = HostReturnInsets.acquire(host, () -> true, () -> {
            verify(host).onApplyWindowInsets(any());
            changes.incrementAndGet();
        });
        assertNotNull(policy);
        assertFalse(policy.ready());
        host.dispatchApplyWindowInsets(incoming);
        org.mockito.ArgumentCaptor<WindowInsets> captured = org.mockito.ArgumentCaptor.forClass(WindowInsets.class);
        verify(host).onApplyWindowInsets(captured.capture());
        WindowInsets applied = captured.getValue();
        assertEquals(Insets.of(0, 52, 0, 24), applied.getInsets(WindowInsets.Type.systemBars()));
        assertEquals(Insets.NONE, incoming.getInsets(WindowInsets.Type.systemBars()));
        for (int type : new int[]{WindowInsets.Type.ime(), WindowInsets.Type.displayCutout(),
                WindowInsets.Type.systemGestures(), WindowInsets.Type.mandatorySystemGestures(), WindowInsets.Type.tappableElement()}) {
            assertEquals(incoming.getInsets(type), applied.getInsets(type));
            assertEquals(incoming.isVisible(type), applied.isVisible(type));
            if (type != WindowInsets.Type.ime()) assertEquals(incoming.getInsetsIgnoringVisibility(type), applied.getInsetsIgnoringVisibility(type));
        }
        assertEquals(incoming.isVisible(WindowInsets.Type.systemBars()), applied.isVisible(WindowInsets.Type.systemBars()));
        assertEquals(incoming.getDisplayCutout(), applied.getDisplayCutout());
        assertTrue(policy.ready());
        assertEquals(1, changes.get());
    }

    @Test public void preservesParentDeliveryAndReleasesOnlyAfterNormalOrdinaryInsets() {
        AtomicInteger parentCalls = new AtomicInteger();
        parent.setOnApplyWindowInsetsListener((view, incoming) -> { parentCalls.incrementAndGet(); return incoming; });
        HostReturnInsets policy = HostReturnInsets.acquire(host, () -> true, changes::incrementAndGet);
        parent.dispatchApplyWindowInsets(insets(false, 24));
        assertEquals(1, parentCalls.get());
        assertTrue(policy.ready());
        policy.finish();
        parent.dispatchApplyWindowInsets(insets(false, 24));
        assertTrue(policy.owned());
        parent.dispatchApplyWindowInsets(insets(true, 24));
        assertFalse(policy.owned());
        parent.dispatchApplyWindowInsets(insets(true, 24));
        assertEquals(4, parentCalls.get());
        org.mockito.ArgumentCaptor<WindowInsets> captured = org.mockito.ArgumentCaptor.forClass(WindowInsets.class);
        verify(host, times(4)).onApplyWindowInsets(captured.capture());
        for (WindowInsets applied : captured.getAllValues())
            assertEquals(Insets.of(0, 52, 0, 24), applied.getInsets(WindowInsets.Type.systemBars()));
        assertEquals(1, changes.get());
    }

    @Test public void effectiveImeAndBarChangesInvalidateOnlyAfterNormalDelivery() {
        HostReturnInsets policy = HostReturnInsets.acquire(host, () -> true, changes::incrementAndGet);
        host.dispatchApplyWindowInsets(insets(false, 24));
        long first = policy.revision();
        host.dispatchApplyWindowInsets(insets(false, 24));
        assertEquals(first, policy.revision());
        host.dispatchApplyWindowInsets(insets(false, 32));
        assertTrue(policy.revision() > first);
        long second = policy.revision();
        host.dispatchApplyWindowInsets(new WindowInsets.Builder(insets(false, 32))
            .setInsets(WindowInsets.Type.ime(), Insets.NONE).setVisible(WindowInsets.Type.ime(), false).build());
        assertTrue(policy.revision() > second);
        assertEquals(3, changes.get());
    }

    @Test public void competingOwnerCannotOverwriteOrRemoveTheCurrentPolicy() {
        HostReturnInsets first = HostReturnInsets.acquire(host, () -> true, changes::incrementAndGet);
        assertNull(HostReturnInsets.acquire(host, () -> true, () -> fail("Competing callback")));
        host.dispatchApplyWindowInsets(insets(false, 24));
        assertTrue(first.ready());
        first.finish();
        assertNull(HostReturnInsets.acquire(host, () -> true, () -> {}));
        host.dispatchApplyWindowInsets(insets(true, 24));
        HostReturnInsets second = HostReturnInsets.acquire(host, () -> true, changes::incrementAndGet);
        assertNotNull(second);
        first.onViewDetachedFromWindow(host);
        assertTrue(second.owned());
        host.dispatchApplyWindowInsets(insets(false, 24));
        assertTrue(second.ready());
    }

    @Test public void detachReleasesOwnershipAndAllowsLaterAttachedReturn() {
        HostReturnInsets first = HostReturnInsets.acquire(host, () -> true, changes::incrementAndGet);
        host.dispatchApplyWindowInsets(insets(false, 24));
        parent.removeView(host);
        assertFalse(first.owned());
        assertFalse(first.ready());
        assertNull(ReflectionHelpers.getField(first, "changed"));
        parent.addView(host);
        assertNotNull(HostReturnInsets.acquire(host, () -> true, changes::incrementAndGet));
    }

    @Test public void retiredLifetimeReleasesWithoutAdaptingTheNewOwnerInsets() {
        AtomicBoolean current = new AtomicBoolean(true);
        HostReturnInsets policy = HostReturnInsets.acquire(host, current::get, changes::incrementAndGet);
        current.set(false);
        WindowInsets incoming = insets(false, 24);
        host.dispatchApplyWindowInsets(incoming);
        verify(host).onApplyWindowInsets(same(incoming));
        assertFalse(policy.owned());
        assertEquals(0, changes.get());
    }

    @Test public void finishSeversGameCallbacksWhileHostPolicyWaitsForOrdinaryMap() {
        HostReturnInsets policy = HostReturnInsets.acquire(host, () -> true, changes::incrementAndGet);
        host.dispatchApplyWindowInsets(insets(false, 24));
        policy.finish();
        assertNull(ReflectionHelpers.getField(policy, "current"));
        assertNull(ReflectionHelpers.getField(policy, "changed"));
        java.util.Map<?, ?> owners = ReflectionHelpers.getStaticField(HostReturnInsets.class, "owners");
        assertTrue(owners.get(host) instanceof java.lang.ref.WeakReference);
        host.dispatchApplyWindowInsets(insets(false, 32));
        assertTrue(policy.owned());
        assertEquals(1, changes.get());
        host.dispatchApplyWindowInsets(insets(true, 32));
        assertFalse(policy.owned());
    }
}
