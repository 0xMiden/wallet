package ee.forgr.capacitor_inappbrowser;

import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.PixelCopy;
import android.view.Window;
import java.util.function.IntConsumer;

interface BreadSnapshotter {
    void capture(Window window, Rect rect, Bitmap into, IntConsumer done);
    void encode(Runnable work);

    BreadSnapshotter PIXEL_COPY = new BreadSnapshotter() {
        private Handler encoder;

        @Override public void capture(Window window, Rect rect, Bitmap into, IntConsumer done) {
            PixelCopy.request(window, rect, into, done::accept, new Handler(Looper.getMainLooper()));
        }

        @Override public synchronized void encode(Runnable work) {
            if (encoder == null) {
                HandlerThread thread = new HandlerThread("bread-snapshot");
                thread.start();
                encoder = new Handler(thread.getLooper());
            }
            encoder.post(work);
        }
    };
}
