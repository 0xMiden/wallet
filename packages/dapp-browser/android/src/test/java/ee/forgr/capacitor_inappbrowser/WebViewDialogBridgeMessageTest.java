package ee.forgr.capacitor_inappbrowser;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

// Native messages carry frame identity; the JavaScript-interface fallback does not.
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
    public void theFallbackForwardsAGenericEventWithoutFrameIdentity() throws Exception {
        String envelope = new JSONObject()
            .put("origin", "https://dapp.test")
            .put("top", true)
            .put(
                "message",
                new JSONObject()
                    .put("detail", new JSONObject().put("type", "DOWNLOAD_FILE").put("filename", "note.mno"))
                    .toString()
            )
            .toString();
        JSONObject out = new JSONObject(WebViewDialog.fallbackBridgeMessage(envelope));
        assertNull(out.opt("mainFrame"));
        assertNull(out.opt("frameOrigin"));
        assertEquals("DOWNLOAD_FILE", out.getJSONObject("detail").getString("type"));
        assertEquals("note.mno", out.getJSONObject("detail").getString("filename"));

        envelope = new JSONObject()
            .put("origin", "https://dapp.test")
            .put("top", true)
            .put("message", new JSONObject().put("detail", new JSONObject().put("type", "PUBLIC_NOTE_SUCCESS")).toString())
            .toString();
        out = new JSONObject(WebViewDialog.fallbackBridgeMessage(envelope));
        assertNull(out.opt("mainFrame"));
        assertNull(out.opt("frameOrigin"));
        assertEquals("PUBLIC_NOTE_SUCCESS", out.getJSONObject("detail").getString("type"));

        String walletRequest = new JSONObject()
            .put("mainFrame", true)
            .put("frameOrigin", "https://dapp.test")
            .put("type", "MIDEN_PAGE_REQUEST")
            .put("payload", "PING")
            .put("reqId", "p1")
            .toString();
        envelope = new JSONObject()
            .put("origin", "https://evil.example")
            .put("top", true)
            .put("message", walletRequest)
            .toString();
        out = new JSONObject(WebViewDialog.fallbackBridgeMessage(envelope));
        assertNull(out.opt("mainFrame"));
        assertNull(out.opt("frameOrigin"));
        assertEquals("MIDEN_PAGE_REQUEST", out.getString("type"));
        assertEquals("p1", out.getString("reqId"));
        assertFalse(out.toString().contains("https://evil.example"));

        envelope = new JSONObject().put("origin", "https://dapp.test").put("top", true).put("message", "hello").toString();
        assertEquals("hello", WebViewDialog.fallbackBridgeMessage(envelope));
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
