package ee.forgr.capacitor_inappbrowser;

import android.net.Uri;
import android.os.Looper;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowToast;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class PermissionDeniedToastTest {
    private static final String INSTANCE = "permission-toast-fixture";
    private AppCompatActivity activity;
    private RecordingPlugin plugin;
    private WebViewDialog dialog;
    private WebChromeClient chrome;
    private MockedStatic<WebViewFeature> features;
    private MockedStatic<WebViewCompat> webkit;

    private static class RecordingPlugin extends InAppBrowserPlugin {
        final List<JSObject> permissionEvents = new ArrayList<>();

        @Override protected void notifyListeners(String name, JSObject data, boolean retainUntilConsumed) {
            if ("permissionDeniedToast".equals(name)) permissionEvents.add(data);
        }
    }

    @Before public void setUp() {
        org.robolectric.android.controller.ActivityController<AppCompatActivity> host = Robolectric.buildActivity(AppCompatActivity.class);
        activity = host.get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        host.setup().visible();
        features = mockStatic(WebViewFeature.class);
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)).thenReturn(true);
        webkit = mockStatic(WebViewCompat.class);
        Bridge bridge = mock(Bridge.class);
        when(bridge.getWebView()).thenReturn(new WebView(activity));
        plugin = spy(new RecordingPlugin());
        doReturn(activity).when(plugin).getActivity();
        doReturn(activity).when(plugin).getContext();
        doReturn(bridge).when(plugin).getBridge();
        PluginCall call = mock(PluginCall.class);
        when(call.getString(anyString(), anyString())).thenAnswer(invocation -> invocation.getArgument(1));
        when(call.getBoolean(anyString(), anyBoolean())).thenAnswer(invocation -> invocation.getArgument(1));
        when(call.getString("id")).thenReturn(INSTANCE);
        when(call.getString("id", WebViewRegistry.DEFAULT_INSTANCE_ID)).thenReturn(INSTANCE);
        when(call.getString("url")).thenReturn("https://private.fixture.example/path?secret=value");
        when(call.getData()).thenReturn(new JSObject());
        when(call.getString("toolbarType", "")).thenReturn("default");
        when(call.getInt("x")).thenReturn(0);
        when(call.getInt("y")).thenReturn(83);
        when(call.getInt("width")).thenReturn(390);
        when(call.getInt("height")).thenReturn(650);
        plugin.openWebView(call);
        shadowOf(Looper.getMainLooper()).idle();
        // Immediate presentation resolves in both the dialog and plugin open path.
        // Permission cases require successful setup, independently of that count.
        verify(call, atLeastOnce()).resolve();
        verify(call, never()).reject(anyString());
        dialog = WebViewRegistry.getShared().get(INSTANCE);
        assertNotNull("Real plugin open must construct and register the dialog", dialog);
        WebView webView = ReflectionHelpers.getField(dialog, "_webView");
        chrome = shadowOf(webView).getWebChromeClient();
        assertNotNull(chrome);
        ShadowToast.reset();
        assertTrue(plugin.permissionEvents.isEmpty());
    }

    @After public void tearDown() {
        if (dialog != null) dialog.forceClose();
        WebViewRegistry.getShared().remove(INSTANCE);
        if (webkit != null) webkit.close();
        if (features != null) features.close();
        if (activity != null) activity.finish();
    }

    private PermissionRequest request(String resource) {
        PermissionRequest request = mock(PermissionRequest.class);
        when(request.getResources()).thenReturn(new String[] {resource});
        when(request.getOrigin()).thenReturn(Uri.parse("https://private.fixture.example"));
        return request;
    }

    private void assertToastCount(int count) {
        assertEquals(count, ShadowToast.shownToastCount());
        assertEquals("Permission Denied", ShadowToast.getTextOfLatestToast());
        assertEquals(Toast.LENGTH_SHORT, ShadowToast.getLatestToast().getDuration());
    }

    private void assertEmptyEvents(int count) {
        assertEquals("Each displayed permission toast must reach the real plugin event boundary", count, plugin.permissionEvents.size());
        for (JSObject event : plugin.permissionEvents) assertEquals("Permission event must contain no request, URL, origin or instance data", 0, event.length());
    }

    @Test public void cancellationDeniesAndClearsPendingRequestAndEmitsOneEmptyEvent() {
        PermissionRequest pending = request(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        dialog.currentPermissionRequest = pending;
        chrome.onPermissionRequestCanceled(pending);
        assertToastCount(1);
        verify(pending).deny();
        assertNull(dialog.currentPermissionRequest);
        assertEmptyEvents(1);
    }

    @Test public void cancellationWithoutPendingRequestStillReportsTheDisplayedToast() {
        PermissionRequest canceled = request(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
        chrome.onPermissionRequestCanceled(canceled);
        assertToastCount(1);
        verify(canceled, never()).deny();
        assertNull(dialog.currentPermissionRequest);
        assertEmptyEvents(1);
    }

    @Test public void cancellationPreservesDenialOfStoredRequestWhenArgumentDiffers() {
        PermissionRequest stored = request(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        PermissionRequest canceled = request(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
        dialog.currentPermissionRequest = stored;
        chrome.onPermissionRequestCanceled(canceled);
        assertToastCount(1);
        verify(stored).deny();
        verify(canceled, never()).deny();
        assertNull(dialog.currentPermissionRequest);
        assertEmptyEvents(1);
    }

    @Test public void twoDisplayedCancellationsEmitTwoEventsButDenyPendingRequestOnce() {
        PermissionRequest pending = request(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        dialog.currentPermissionRequest = pending;
        chrome.onPermissionRequestCanceled(pending);
        chrome.onPermissionRequestCanceled(pending);
        assertToastCount(2);
        verify(pending, times(1)).deny();
        assertNull(dialog.currentPermissionRequest);
        assertEmptyEvents(2);
    }

    @Test public void unsupportedPermissionDenialWithoutToastEmitsNothing() {
        PermissionRequest unsupported = request("private-unsupported-resource");
        chrome.onPermissionRequest(unsupported);
        verify(unsupported).deny();
        assertEquals(0, ShadowToast.shownToastCount());
        assertEmptyEvents(0);
    }
}
