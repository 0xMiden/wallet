package ee.forgr.capacitor_inappbrowser.navbar;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import java.lang.reflect.Method;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class NavbarPresentationTest {

    @Test
    public void condensedNavbarHidesLabelsAndSecondaryRowButKeepsDestinationsTappable() throws ReflectiveOperationException {
        var controller = Robolectric.buildActivity(Activity.class).setup().visible();
        try {
            Activity activity = controller.get();
            ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
            NavbarOverlayManager manager = new NavbarOverlayManager(activity);
            manager.show(List.of(item("Wallet"), item("Activity"), item("Browser"), item("Settings")), "Wallet");
            manager.setSecondaryItems(List.of(item("Send")), null);
            settleAndLayout(decor);

            List<NavbarButton> destinations = descendants(decor, NavbarButton.class);
            assertEquals(4, destinations.size());
            assertTrue(destinations.stream().allMatch(NavbarPresentationTest::hasVisibleLabel));
            assertTrue(hasVisibleSecondaryRow(decor));

            requestPresentation(manager, "condensed");
            settleAndLayout(decor);

            assertFalse("Condensed navbar still shows destination labels", destinations.stream().anyMatch(NavbarPresentationTest::hasVisibleLabel));
            assertFalse("Condensed navbar still shows a secondary action", hasVisibleSecondaryRow(decor));
            assertEquals(destinations, descendants(decor, NavbarButton.class));
            for (NavbarButton button : destinations) {
                assertTrue(isVisible(button) && button.isEnabled() && button.isClickable());
            }

            requestPresentation(manager, "expanded");
            settleAndLayout(decor);

            assertTrue(destinations.stream().allMatch(NavbarPresentationTest::hasVisibleLabel));
            assertTrue(hasVisibleSecondaryRow(decor));
        } finally {
            controller.pause().stop().destroy();
        }
    }

    private static NavbarState.Item item(String title) {
        return new NavbarState.Item(title, title, "house.fill");
    }

    private static void requestPresentation(NavbarOverlayManager manager, String presentation) throws ReflectiveOperationException {
        Method setter;
        try {
            setter = NavbarOverlayManager.class.getMethod("setPresentation", String.class);
        } catch (NoSuchMethodException preImplementation) {
            // Let the unchanged navbar fail the rendered assertion on the pre-implementation source.
            return;
        }
        setter.invoke(manager, presentation);
    }

    private static void settleAndLayout(ViewGroup decor) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        int width = View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY);
        int height = View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY);
        decor.measure(width, height);
        decor.layout(0, 0, decor.getMeasuredWidth(), decor.getMeasuredHeight());
    }

    private static boolean isVisible(View view) {
        if (!view.isShown()) return false;
        for (View node = view; node != null; node = node.getParent() instanceof View parent ? parent : null) {
            if (node.getAlpha() <= 0.01f || node.getWidth() == 0 || node.getHeight() == 0) return false;
        }
        return true;
    }

    private static boolean hasVisibleLabel(NavbarButton button) {
        return descendants(button, TextView.class).stream().anyMatch(NavbarPresentationTest::isVisible);
    }

    private static boolean hasVisibleSecondaryRow(ViewGroup decor) {
        return descendants(decor, NavbarSecondaryButton.class).stream().anyMatch(NavbarPresentationTest::isVisible);
    }

    private static <T extends View> List<T> descendants(View root, Class<T> type) {
        List<T> matches = new ArrayList<>();
        if (type.isInstance(root)) matches.add(type.cast(root));
        if (root instanceof ViewGroup group) {
            for (int index = 0; index < group.getChildCount(); index++) {
                matches.addAll(descendants(group.getChildAt(index), type));
            }
        }
        return matches;
    }
}
