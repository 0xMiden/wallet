package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedConstruction;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BridgeLogPrivacyTest {
    private static final String MARKER = "bread-log-marker-1582";
    private static final String INSTANCE_ID = "bridge-log-fixture";
    private Activity activity;
    private RecordingPlugin plugin;
    private WebViewDialog dialog;
    private WebViewCallbacks callbacks;
    private MockedConstruction<WebViewDialog> dialogs;

    @Before public void setUp() {
        activity = Robolectric.buildActivity(Activity.class).setup().visible().get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        plugin = spy(new RecordingPlugin());
        AppCompatActivity pluginActivity = mock(AppCompatActivity.class);
        doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return null; }).when(pluginActivity).runOnUiThread(any());
        doReturn(pluginActivity).when(plugin).getActivity();
        doReturn(activity).when(plugin).getContext();
        Bridge bridge = mock(Bridge.class);
        doReturn(bridge).when(plugin).getBridge();
        when(bridge.getWebView()).thenReturn(new WebView(activity));
        dialogs = mockConstruction(WebViewDialog.class, (created, context) -> {
            Options options = (Options) context.arguments().get(2);
            callbacks = options.getCallbacks();
        });
        PluginCall call = mock(PluginCall.class);
        when(call.getString("url")).thenReturn("https://fixture.example");
        when(call.getString("id")).thenReturn(INSTANCE_ID);
        when(call.getString("id", WebViewRegistry.DEFAULT_INSTANCE_ID)).thenReturn(INSTANCE_ID);
        when(call.getData()).thenReturn(new JSObject());
        plugin.openWebView(call);
        verify(call).resolve();
        assertEquals(1, dialogs.constructed().size());
        dialog = dialogs.constructed().get(0);
        assertNotNull(callbacks);
        ShadowLog.clear();
    }

    @After public void tearDown() {
        WebViewRegistry.getShared().remove(INSTANCE_ID);
        if (dialogs != null) dialogs.close();
        activity.finish();
        ShadowLog.clear();
    }

    @Test public void pageMessageContentStaysOutOfLogs() {
        callbacks.javascriptCallback(new JSObject().put("word", MARKER).toString());
        JSObject event = receivedMessage();
        assertEquals(MARKER, event.getString("word"));
        assertEquals(INSTANCE_ID, event.getString("id"));
        assertFalse(event.has("rawMessage"));
        assertNoMarkerInLogs();
    }

    @Test public void malformedPageMessageContentStaysOutOfLogs() {
        callbacks.javascriptCallback(MARKER);
        JSObject event = receivedMessage();
        assertEquals(MARKER, event.getString("rawMessage"));
        assertEquals(INSTANCE_ID, event.getString("id"));
        assertNoMarkerInLogs();
    }

    @Test public void walletMessageContentStaysOutOfLogs() {
        JSObject detail = new JSObject().put("word", MARKER);
        PluginCall call = mock(PluginCall.class);
        when(call.getString("id")).thenReturn(INSTANCE_ID);
        when(call.getObject("detail")).thenReturn(detail);
        plugin.postMessage(call);
        verify(dialog).postMessageToJS(detail);
        verify(call).resolve();
        verify(call, never()).reject(anyString());
        assertNoMarkerInLogs();
    }

    @Test public void walletMessageWithoutDetailStillRejects() {
        PluginCall call = mock(PluginCall.class);
        when(call.getString("id")).thenReturn(INSTANCE_ID);
        plugin.postMessage(call);
        verify(call).reject("No event data provided");
        verify(call, never()).resolve();
        verify(dialog, never()).postMessageToJS(any());
    }

    private JSObject receivedMessage() {
        JSObject received = null;
        for (RecordingPlugin.Event event : plugin.events) {
            if (!"messageFromWebview".equals(event.name)) continue;
            assertNull("one page message, one event", received);
            received = event.data;
        }
        assertNotNull(received);
        return received;
    }

    // Plugin.notifyListeners is protected in another package, so the test records events by overriding it.
    public static class RecordingPlugin extends InAppBrowserPlugin {
        static final class Event {
            final String name;
            final JSObject data;

            Event(String name, JSObject data) {
                this.name = name;
                this.data = data;
            }
        }

        final java.util.List<Event> events = new java.util.ArrayList<>();

        @Override
        protected void notifyListeners(String eventName, JSObject data) {
            events.add(new Event(eventName, data));
        }
    }

    private static void assertNoMarkerInLogs() {
        for (ShadowLog.LogItem log : ShadowLog.getLogs()) {
            assertFalse("Bridge content in log message", log.msg != null && log.msg.contains(MARKER));
            for (Throwable failure = log.throwable; failure != null; failure = failure.getCause()) {
                assertFalse("Bridge content in logged throwable", failure.getMessage() != null && failure.getMessage().contains(MARKER));
            }
        }
    }
}
