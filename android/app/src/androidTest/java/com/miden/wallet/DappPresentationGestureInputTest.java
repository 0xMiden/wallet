package com.miden.wallet;

import static org.junit.Assert.*;

import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DappPresentationGestureInputTest {
    private static final String PACKAGE = "com.miden.wallet";

    @Test(timeout = 600_000)
    public void continuousGesturesOnTheExistingManagedPresentation() throws Exception {
        assertEquals(36, Build.VERSION.SDK_INT);
        assertEquals(36, InstrumentationRegistry.getInstrumentation().getTargetContext().getApplicationInfo().targetSdkVersion);
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        Set<Integer> commands = new HashSet<>();
        int executed = 0;
        long deadline = SystemClock.elapsedRealtime() + 540_000;
        // Start before the host launches MainActivity; never restart the prepared fixture's target process.
        try (ServerSocket server = new ServerSocket(8736, 1, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(1000);
            Bundle ready = new Bundle();
            ready.putString("stream", "DappGestureInput ready port=8736\n");
            InstrumentationRegistry.getInstrumentation().sendStatus(0, ready);
            while (SystemClock.elapsedRealtime() < deadline) {
                Socket connection;
                try { connection = server.accept(); }
                catch (SocketTimeoutException waiting) { continue; }
                try (Socket socket = connection) {
                    socket.setSoTimeout(10_000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    StringBuilder line = new StringBuilder();
                    for (int ch; (ch = reader.read()) != '\n';) {
                        assertTrue("a complete bounded command is required", ch >= 0 && line.length() < 8192);
                        line.append((char) ch);
                    }
                    JSONObject command = new JSONObject(line.toString());
                    int id = integer(command, "id", 1, Integer.MAX_VALUE);
                    assertTrue("duplicate command id", commands.add(id));
                    String op = command.getString("op");
                    PrintWriter output = new PrintWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8), true);
                    if ("stop".equals(op)) {
                        assertEquals("all four real gestures must execute", 4, executed);
                        output.println(reply(id, "done", executed, device));
                        return;
                    }
                    assertEquals("wallet must own the foreground before native input", PACKAGE, device.getCurrentPackageName());
                    if ("bounds".equals(op)) {
                        List<UiObject2> capsules = device.findObjects(By.pkg(PACKAGE)
                            .clazz("android.widget.ImageButton").desc(command.getString("label")));
                        assertEquals("one actual accessible native capsule", 1, capsules.size());
                        Rect bounds = capsules.get(0).getVisibleBounds();
                        assertTrue("capsule has nonempty visible bounds", !bounds.isEmpty());
                        output.println(reply(id, "done", executed, device).put("capsule", new JSONObject()
                            .put("left", bounds.left).put("top", bounds.top)
                            .put("right", bounds.right).put("bottom", bounds.bottom)));
                        continue;
                    }
                    assertEquals("only continuous native swipe commands are accepted", "swipe", op);
                    assertTrue("no extra gestures", executed < 4);
                    int steps = integer(command, "steps", 10, 200);
                    JSONArray points = command.getJSONArray("points");
                    assertTrue("bounded continuous path", points.length() >= 2 && points.length() <= 6);
                    Point[] path = new Point[points.length()];
                    for (int index = 0; index < path.length; index++) {
                        JSONObject point = points.getJSONObject(index);
                        path[index] = new Point(integer(point, "x", 0, device.getDisplayWidth() - 1),
                            integer(point, "y", 0, device.getDisplayHeight() - 1));
                    }
                    long inputStarted = SystemClock.elapsedRealtime();
                    output.println(reply(id, "started", executed, device).put("inputStartedMs", inputStarted));
                    assertTrue("one continuous UiDevice swipe must inject successfully", device.swipe(path, steps));
                    executed++;
                    long inputEnded = SystemClock.elapsedRealtime();
                    output.println(reply(id, "injected", executed, device).put("inputEndedMs", inputEnded));
                    assertEquals("wallet remains foreground after input", PACKAGE, device.getCurrentPackageName());
                    output.println(reply(id, "done", executed, device)
                        .put("inputStartedMs", inputStarted).put("inputEndedMs", inputEnded));
                }
            }
            fail("gesture host did not complete its bounded acceptance session");
        }
    }

    private static int integer(JSONObject object, String key, int minimum, int maximum) throws Exception {
        Object value = object.get(key);
        assertTrue("integer field required: " + key, value instanceof Number);
        double number = ((Number) value).doubleValue();
        assertTrue("bounded integer field required: " + key,
            Double.isFinite(number) && number >= minimum && number <= maximum && number == Math.rint(number));
        return (int) number;
    }

    private static JSONObject reply(int id, String phase, int executed, UiDevice device) throws Exception {
        return new JSONObject().put("id", id).put("phase", phase).put("executed", executed)
            .put("width", device.getDisplayWidth()).put("height", device.getDisplayHeight());
    }
}
