package com.miden.wallet;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class AuthTabCertificateSetupTest {
    private static final long UI_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(20);
    private static final String CERTIFICATE_FILE = "auth-tab-root-ca.crt";

    @Test
    public void installFixtureAuthorityThroughSettings() throws Exception {
        String expectedSubject = InstrumentationRegistry.getArguments().getString("caSubject");
        assertNotNull("caSubject instrumentation argument", expectedSubject);
        String devicePin = InstrumentationRegistry.getArguments().getString("devicePin");
        assertNotNull("devicePin instrumentation argument", devicePin);

        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        unlockWithPin(device, devicePin);
        Intent settings = new Intent(Settings.ACTION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(settings);

        clickText(device, "Security & privacy");
        clickText(device, "More security & privacy");
        clickText(device, "Encryption & credentials");
        clickText(device, "Install a certificate");
        clickText(device, "CA certificate");
        clickPastMore(device, "Install anyway");
        confirmPinIfAsked(device, devicePin, "Downloads");
        clickText(device, "Downloads");
        clickText(device, CERTIFICATE_FILE);
        confirmPinIfAsked(device, devicePin, "Install anyway", "Install", "OK", "Done");
        clickFirstAvailable(device, "Install anyway", "Install", "OK");
        clickFirstAvailable(device, "Install anyway", "Install", "OK", "Done");

        assertTrue("fixture CA should be installed in the user CA store",
            waitForCertificate(expectedSubject));
        Log.i("AuthTabAcceptance", "fixtureCaInstalled=true subject=" + expectedSubject);
    }

    private static boolean waitForCertificate(String expectedSubject) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            KeyStore keyStore = KeyStore.getInstance("AndroidCAStore");
            keyStore.load(null);
            for (String alias : java.util.Collections.list(keyStore.aliases())) {
                Certificate certificate = keyStore.getCertificate(alias);
                if (certificate instanceof X509Certificate
                    && ((X509Certificate) certificate).getSubjectX500Principal().getName()
                        .contains(expectedSubject)) {
                    return true;
                }
            }
            Thread.sleep(500);
        }
        return false;
    }

    // A user-CA install on a PIN-locked device asks for the screen lock before it continues.
    // The runner sets the device PIN just before this test, so the screen can already be on the PIN keyguard.
    private static void unlockWithPin(UiDevice device, String devicePin) throws Exception {
        device.wakeUp();
        KeyguardManager keyguard = (KeyguardManager) InstrumentationRegistry.getInstrumentation()
            .getTargetContext().getSystemService(Context.KEYGUARD_SERVICE);
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(UI_TIMEOUT_MS);
        while (keyguard.isKeyguardLocked() && System.nanoTime() < deadline) {
            device.executeShellCommand("wm dismiss-keyguard");
            device.waitForIdle();
            device.executeShellCommand("input text " + devicePin);
            device.executeShellCommand("input keyevent KEYCODE_ENTER");
            device.waitForWindowUpdate(null, 1000);
        }
        assertTrue("device is still locked behind its PIN keyguard", !keyguard.isKeyguardLocked());
    }

    private static void confirmPinIfAsked(UiDevice device, String devicePin, String... nextLabels) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(UI_TIMEOUT_MS);
        while (System.nanoTime() < deadline) {
            UiObject2 pin = device.findObject(By.res("com.android.settings", "password_entry"));
            if (pin != null) {
                pin.setText(devicePin);
                UiObject2 next = device.findObject(By.res("com.android.settings", "next_button"));
                if (next != null && next.isEnabled()) next.click();
                else device.pressEnter();
                assertTrue("device PIN confirmation still showing",
                    device.wait(Until.gone(By.res("com.android.settings", "password_entry")), UI_TIMEOUT_MS));
                device.waitForIdle();
                return;
            }
            // Android 14 confirms the credential with the system UI keypad, not a Settings field.
            if (device.findObject(label("Re-enter your PIN")) != null
                || device.findObject(label("Enter your device PIN to continue")) != null) {
                device.executeShellCommand("input text " + devicePin);
                device.executeShellCommand("input keyevent KEYCODE_ENTER");
                assertTrue("device PIN confirmation still showing",
                    device.wait(Until.gone(label("Re-enter your PIN")), UI_TIMEOUT_MS));
                device.waitForIdle();
                return;
            }
            for (String label : nextLabels) {
                if (device.findObject(label(label)) != null) return;
            }
            device.waitForWindowUpdate(null, 500);
        }
    }

    private static void clickText(UiDevice device, String text) {
        UiObject2 element = findText(device, text, UI_TIMEOUT_MS);
        assertNotNull("Settings text not found: " + text + "; on screen: " + visibleLabels(device), element);
        element.click();
        device.waitForIdle();
    }

    // The CA warning is a setup-wizard page: its primary button reads "More" until the text is scrolled to the end.
    private static void clickPastMore(UiDevice device, String text) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(UI_TIMEOUT_MS);
        while (System.nanoTime() < deadline) {
            UiObject2 element = device.findObject(label(text));
            if (element != null) {
                element.click();
                device.waitForIdle();
                return;
            }
            UiObject2 more = device.findObject(label("More"));
            if (more != null) {
                more.click();
                device.waitForIdle();
            } else {
                device.waitForWindowUpdate(null, 500);
            }
        }
        throw new AssertionError("Settings text not found: " + text + "; on screen: " + visibleLabels(device));
    }

    // Settings renders some buttons in capitals ("INSTALL ANYWAY"), so labels match without case.
    private static BySelector label(String text) {
        return By.text(Pattern.compile("(?i)" + Pattern.quote(text)));
    }

    private static String visibleLabels(UiDevice device) {
        StringBuilder labels = new StringBuilder();
        labels.append("pkg=").append(device.getCurrentPackageName()).append(' ');
        for (UiObject2 node : device.findObjects(By.text(Pattern.compile("(?s).+")))) {
            String label = node.getText() != null ? node.getText() : node.getContentDescription();
            if (label != null && !label.isEmpty()) {
                labels.append('[').append(label).append(node.isClickable() ? "*" : "").append(']');
            }
        }
        return labels.toString();
    }

    private static void clickFirstAvailable(UiDevice device, String... labels) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(UI_TIMEOUT_MS);
        while (System.nanoTime() < deadline) {
            for (String label : labels) {
                UiObject2 element = device.findObject(label(label));
                if (element != null) {
                    element.click();
                    device.waitForIdle();
                    return;
                }
            }
            device.waitForWindowUpdate(null, 500);
        }
    }

    private static UiObject2 findText(UiDevice device, String text, long timeoutMs) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        while (System.nanoTime() < deadline) {
            UiObject2 element = device.findObject(label(text));
            if (element != null) {
                return element;
            }
            element = device.findObject(By.textContains(text));
            if (element != null) {
                return element;
            }
            int width = device.getDisplayWidth();
            int height = device.getDisplayHeight();
            device.swipe(width / 2, height * 4 / 5, width / 2, height / 3, 12);
            device.waitForIdle();
        }
        return null;
    }
}
