package ee.forgr.capacitor_inappbrowser;

import android.graphics.RectF;

final class BreadMorphCard {
    final RectF rect;
    final float cornerRadius;

    BreadMorphCard(RectF rect, float cornerRadius) {
        this.rect = rect;
        this.cornerRadius = cornerRadius;
    }
}
