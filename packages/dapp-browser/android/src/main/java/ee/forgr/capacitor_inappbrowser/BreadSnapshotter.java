package ee.forgr.capacitor_inappbrowser;

import android.graphics.Bitmap;
import android.graphics.Rect;
import android.view.PixelCopy;
import android.view.Window;
import java.util.function.IntConsumer;

interface BreadSnapshotter {
    void capture(Window window, Rect rect, Bitmap into, IntConsumer done);
    void encode(Runnable work);

    BreadSnapshotter PIXEL_COPY = new BreadSnapshotter() {
        @Override public void capture(Window window, Rect rect, Bitmap into, IntConsumer done) { done.accept(PixelCopy.ERROR_UNKNOWN); }
        @Override public void encode(Runnable work) { work.run(); }
    };
}
