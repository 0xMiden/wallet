package ee.forgr.capacitor_inappbrowser;

import android.graphics.RectF;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BreadMorphGeometryTest {
    private static final float DENSITY = 3;
    private static final float SLOT_WIDTH = 1206;
    private static final float SLOT_HEIGHT = 2259;

    private static BreadMorphCard card() {
        return new BreadMorphCard(new RectF(846, 1950, 846 + 312, 1950 + 396), 48);
    }

    @Test public void physicsMatchResponseAndDampingRatio() {
        assertEquals(223.8f, BreadMorphPhysics.EXPAND.stiffness, 0.1f);
        assertEquals(0.88f, BreadMorphPhysics.EXPAND.dampingRatio, 0.001f);
        assertEquals(273.4f, BreadMorphPhysics.COLLAPSE.stiffness, 0.1f);
        assertEquals(0.90f, BreadMorphPhysics.COLLAPSE.dampingRatio, 0.001f);
        assertEquals(246.7f, BreadMorphPhysics.RELEASE.stiffness, 0.1f);
        assertEquals(0.82f, BreadMorphPhysics.RELEASE.dampingRatio, 0.001f);
    }

    @Test public void poseEndpointsMatchCardAndSlot() {
        BreadMorphGeometry.Pose start = BreadMorphGeometry.pose(0, card(), SLOT_WIDTH, SLOT_HEIGHT);
        assertEquals(846, start.translationX, 0.05f);
        assertEquals(1950, start.translationY, 0.05f);
        assertEquals(312, start.scale * SLOT_WIDTH, 0.05f);
        assertEquals(396, start.scale * start.cropHeight, 0.05f);
        assertEquals(48, start.radius * start.scale, 0.05f);
        assertTrue(start.elevationDp > 0);
        assertEquals(1, start.alpha, 0);
        BreadMorphGeometry.Pose end = BreadMorphGeometry.pose(1, card(), SLOT_WIDTH, SLOT_HEIGHT);
        assertEquals(1, end.scale, 1e-6f);
        assertEquals(0, end.translationX, 1e-4f);
        assertEquals(0, end.translationY, 1e-4f);
        assertEquals(SLOT_HEIGHT, end.cropHeight, 1e-3f);
        assertEquals(0, end.radius, 1e-4f);
        assertEquals(0, end.elevationDp, 1e-4f);
        assertEquals(1, end.alpha, 0);
    }

    @Test public void radiusPeaksNearAThirdOnA402DpSlot() {
        float peak = 0, at = -1;
        for (int i = 0; i <= 1000; i++) {
            BreadMorphGeometry.Pose pose = BreadMorphGeometry.pose(i / 1000f, card(), SLOT_WIDTH, SLOT_HEIGHT);
            if (pose.radius * pose.scale > peak) { peak = pose.radius * pose.scale; at = i / 1000f; }
        }
        assertEquals(20.9f, peak / DENSITY, 0.3f);
        assertEquals(0.33f, at, 0.03f);
    }

    @Test public void missingCardPoseScalesToNinetyPercentWithFade() {
        BreadMorphGeometry.Pose start = BreadMorphGeometry.pose(0, null, SLOT_WIDTH, SLOT_HEIGHT);
        assertEquals(0.9f, start.scale, 1e-6f);
        assertEquals(0.05f * SLOT_WIDTH, start.translationX, 0.01f);
        assertEquals(0.05f * SLOT_HEIGHT, start.translationY, 0.01f);
        assertEquals(SLOT_HEIGHT, start.cropHeight, 0);
        assertEquals(0, start.alpha, 0);
        BreadMorphGeometry.Pose middle = BreadMorphGeometry.pose(0.5f, null, SLOT_WIDTH, SLOT_HEIGHT);
        assertEquals(0.95f, middle.scale, 1e-6f);
        assertEquals(0.5f, middle.alpha, 1e-6f);
        BreadMorphGeometry.Pose end = BreadMorphGeometry.pose(1, null, SLOT_WIDTH, SLOT_HEIGHT);
        assertEquals(1, end.scale, 0);
        assertEquals(0, end.translationX, 0);
        assertEquals(0, end.translationY, 0);
        assertEquals(1, end.alpha, 0);
    }

    @Test public void progressVelocityProjectsAndClamps() {
        RectF card = card().rect;
        RectF slot = new RectF(0, 0, SLOT_WIDTH, SLOT_HEIGHT);
        float dx = slot.centerX() - card.centerX(), dy = slot.centerY() - card.centerY();
        assertEquals(2, BreadMorphGeometry.progressVelocity(2 * dx, 2 * dy, card, slot), 1e-4f);
        assertEquals(-0.5f, BreadMorphGeometry.progressVelocity(-0.5f * dx, -0.5f * dy, card, slot), 1e-4f);
        assertEquals(0, BreadMorphGeometry.progressVelocity(-dy, dx, card, slot), 1e-4f);
        assertEquals(8, BreadMorphGeometry.progressVelocity(1e6f * dx, 1e6f * dy, card, slot), 0);
        assertEquals(-8, BreadMorphGeometry.progressVelocity(-1e6f * dx, -1e6f * dy, card, slot), 0);
        assertEquals(0, BreadMorphGeometry.progressVelocity(500, 500, slot, slot), 0);
    }

    @Test public void rubberBandIsMonotonicAndBounded() {
        assertEquals(0, BreadMorphGeometry.rubberBand(0, 1), 0);
        assertEquals(0.55f, BreadMorphGeometry.rubberBand(0.001f, 1) / 0.001f, 1e-3f);
        float previous = 0;
        for (int i = 1; i <= 1000; i++) {
            float value = BreadMorphGeometry.rubberBand(i / 100f, 1);
            assertTrue(value > previous);
            assertTrue(value < 1);
            previous = value;
        }
        assertEquals(-BreadMorphGeometry.rubberBand(0.5f, 1), BreadMorphGeometry.rubberBand(-0.5f, 1), 1e-6f);
        assertEquals(2 * BreadMorphGeometry.rubberBand(0.5f, 1), BreadMorphGeometry.rubberBand(1, 2), 1e-5f);
    }

    @Test public void hostRectConvertsThroughTheDialogOrigin() {
        BreadMorphCard card = BreadMorphGeometry.hostToWindow(282, 650, 104, 132, 16, DENSITY, 72, 0, 435);
        assertEquals(282 * 3 - 0, card.rect.left, 0.01f);
        assertEquals(650 * 3 + 72 - 435, card.rect.top, 0.01f);
        assertEquals(312, card.rect.width(), 0.01f);
        assertEquals(396, card.rect.height(), 0.01f);
        assertEquals(48, card.cornerRadius, 0.01f);
        BreadMorphCard offset = BreadMorphGeometry.hostToWindow(10, 20, 30, 40, 4, 2, 50, 6, 80);
        assertEquals(14, offset.rect.left, 0.01f);
        assertEquals(10, offset.rect.top, 0.01f);
        assertEquals(74, offset.rect.right, 0.01f);
        assertEquals(90, offset.rect.bottom, 0.01f);
    }
}
