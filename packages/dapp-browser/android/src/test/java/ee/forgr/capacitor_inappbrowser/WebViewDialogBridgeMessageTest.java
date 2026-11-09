package ee.forgr.capacitor_inappbrowser;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

// The wallet bridge forwards only main-frame messages, each with the origin of its frame.
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class WebViewDialogBridgeMessageTest {

    @Test
    public void addsTheFrameOriginAndTheMainFrameFlag() throws Exception {
        JSONObject out = new JSONObject(WebViewDialog.bridgeMessage("{\"type\":\"T\",\"reqId\":\"r1\"}", "https://dapp.test"));
        assertEquals("T", out.getString("type"));
        assertEquals("r1", out.getString("reqId"));
        assertEquals("https://dapp.test", out.getString("frameOrigin"));
        assertTrue(out.getBoolean("mainFrame"));
    }

    @Test
    public void theNativeOriginReplacesAnOriginInTheMessage() throws Exception {
        JSONObject out = new JSONObject(
            WebViewDialog.bridgeMessage("{\"frameOrigin\":\"https://other.test\",\"mainFrame\":false}", "https://dapp.test")
        );
        assertEquals("https://dapp.test", out.getString("frameOrigin"));
        assertTrue(out.getBoolean("mainFrame"));
    }

    @Test
    public void putsTextThatIsNotAnObjectInRawMessage() throws Exception {
        JSONObject out = new JSONObject(WebViewDialog.bridgeMessage("hello", "https://dapp.test"));
        assertEquals("hello", out.getString("rawMessage"));
        assertEquals("https://dapp.test", out.getString("frameOrigin"));
    }

    @Test
    public void theFallbackForwardsAnEnvelopeFromTheMainFrame() throws Exception {
        String envelope = new JSONObject()
            .put("origin", "https://dapp.test")
            .put("top", true)
            .put("message", "{\"type\":\"T\"}")
            .toString();
        JSONObject out = new JSONObject(WebViewDialog.fallbackBridgeMessage(envelope));
        assertEquals("T", out.getString("type"));
        assertEquals("https://dapp.test", out.getString("frameOrigin"));
        assertTrue(out.getBoolean("mainFrame"));
    }

    @Test
    public void theFallbackDropsAnEnvelopeFromAnotherFrame() throws Exception {
        String envelope = new JSONObject()
            .put("origin", "https://frame.test")
            .put("top", false)
            .put("message", "{\"type\":\"T\"}")
            .toString();
        assertNull(WebViewDialog.fallbackBridgeMessage(envelope));
    }

    @Test
    public void theFallbackDropsTextThatIsNotAnEnvelope() throws Exception {
        assertNull(WebViewDialog.fallbackBridgeMessage("{\"type\":\"T\",\"reqId\":\"r1\"}"));
        assertNull(WebViewDialog.fallbackBridgeMessage("{\"origin\":\"https://dapp.test\",\"top\":\"true\",\"message\":\"x\"}"));
        assertNull(WebViewDialog.fallbackBridgeMessage("{\"origin\":1,\"top\":true,\"message\":\"x\"}"));
        assertNull(WebViewDialog.fallbackBridgeMessage("not json"));
    }
}
