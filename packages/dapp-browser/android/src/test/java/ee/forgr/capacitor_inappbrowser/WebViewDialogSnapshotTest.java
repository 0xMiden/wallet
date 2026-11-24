package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Looper;
import android.view.PixelCopy;
import android.view.Window;
import android.webkit.WebView;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.PluginCall;
import java.util.ArrayList;
import java.util.List;
import java.util.function.IntConsumer;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

// The standalone dialog (no bread presentation) allocates a full-size bitmap per snapshot request and owns it.
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class WebViewDialogSnapshotTest {
    private Activity activity;
    private WebViewDialog dialog;
    private MockedStatic<WebViewFeature> features;
    private MockedStatic<WebViewCompat> webkit;

    static final class RecordingSnapshotter implements BreadSnapshotter {
        final List<Bitmap> targets = new ArrayList<>();
        final List<Runnable> encodes = new ArrayList<>();
        int result = PixelCopy.SUCCESS;
        boolean fail;
        @Override public void capture(Window window, Rect rect, Bitmap into, IntConsumer done) {
            targets.add(into);
            if (fail) throw new IllegalArgumentException("surface gone");
            done.accept(result);
        }
        @Override public void encode(Runnable work) { encodes.add(work); }
        void runEncodes() { while (!encodes.isEmpty()) encodes.remove(0).run(); }
    }

    @Before public void setUp() {
        activity = Robolectric.buildActivity(Activity.class).setup().visible().get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        features = mockStatic(WebViewFeature.class);
        webkit = mockStatic(WebViewCompat.class);
        webkit.when(() -> WebViewCompat.addDocumentStartJavaScript(any(), anyString(), anySet()))
            .thenReturn(mock(ScriptHandler.class));
        Options options = new Options();
        options.setUrl("https://fixture.example/first");
        options.setToolbarType("default");
        options.setBackgroundColor("white");
        options.setWidth(390); options.setHeight(650); options.setX(0); options.setY(83);
        options.setPluginCall(mock(PluginCall.class));
        options.setCallbacks(mock(WebViewCallbacks.class));
        dialog = new WebViewDialog(activity, androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar, options, null, new WebView(activity));
        dialog.activity = activity;
        dialog.presentWebView();
        assertNull(ReflectionHelpers.getField(dialog, "presentation"));
        WebView webView = spy((WebView) ReflectionHelpers.getField(dialog, "_webView"));
        doReturn(390).when(webView).getWidth();
        doReturn(650).when(webView).getHeight();
        ReflectionHelpers.setField(dialog, "_webView", webView);
    }

    @After public void tearDown() {
        if (dialog != null) dialog.forceClose();
        webkit.close(); features.close();
        activity.finish();
    }

    private RecordingSnapshotter snapshotter() {
        RecordingSnapshotter snapshots = new RecordingSnapshotter();
        ReflectionHelpers.setField(dialog, "snapshotter", snapshots);
        return snapshots;
    }

    @Test public void standaloneCaptureIsRecycledAfterEncode() {
        RecordingSnapshotter snapshots = snapshotter();
        List<String> results = new ArrayList<>();
        dialog.takeSnapshotData(0.5f, 0.7f, results::add);
        assertEquals(1, snapshots.targets.size());
        assertFalse("the encoder still needs the capture", snapshots.targets.get(0).isRecycled());
        snapshots.runEncodes();
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(1, results.size());
        assertTrue(results.get(0).startsWith("data:image/jpeg;base64,"));
        assertTrue("the standalone capture is released once encoded", snapshots.targets.get(0).isRecycled());
    }

    @Test public void failedPixelCopyRecyclesTheCapture() {
        RecordingSnapshotter snapshots = snapshotter();
        snapshots.result = PixelCopy.ERROR_SOURCE_INVALID;
        List<String> results = new ArrayList<>();
        dialog.takeSnapshotData(0.5f, 0.7f, results::add);
        assertEquals(1, results.size());
        assertNull(results.get(0));
        assertTrue(snapshots.encodes.isEmpty());
        assertTrue("a failed copy releases its target", snapshots.targets.get(0).isRecycled());
    }

    @Test public void thrownCaptureRecyclesTheCapture() {
        RecordingSnapshotter snapshots = snapshotter();
        snapshots.fail = true;
        List<String> results = new ArrayList<>();
        dialog.takeSnapshotData(0.5f, 0.7f, results::add);
        assertEquals(1, results.size());
        assertNull(results.get(0));
        assertTrue("a thrown copy releases its target", snapshots.targets.get(0).isRecycled());
    }
}
