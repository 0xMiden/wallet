package com.miden.wallet;

import static com.miden.wallet.AuthTabCertificateSetupTest.clickText;
import static com.miden.wallet.AuthTabCertificateSetupTest.findText;
import static com.miden.wallet.AuthTabCertificateSetupTest.label;
import static com.miden.wallet.AuthTabCertificateSetupTest.unlockWithPin;
import static com.miden.wallet.AuthTabCertificateSetupTest.visibleLabels;
import static org.junit.Assert.assertNotNull;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.StaleObjectException;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Firefox for Android trusts a user-installed CA only with its "Use third party CA certificates" switch, which
 * sits in Secret Settings: About Firefox unlocks that screen for the running session after five taps on the logo.
 * Its default "Ask before opening" for app links also holds the fixture's callback redirect behind an "Open in App"
 * prompt, so links open in apps directly. Both choices are stored preferences and outlive the force-stop below.
 */
@RunWith(AndroidJUnit4.class)
public class FirefoxCustomTabSetupTest {
    private static final String FIREFOX = "org.mozilla.firefox";
    private static final String THIRD_PARTY_CA = "Use third party CA certificates";
    private static final long UI_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(20);

    @Test
    public void trustUserCertificatesAndOpenLinksInApps() throws Exception {
        String devicePin = InstrumentationRegistry.getArguments().getString("devicePin");
        assertNotNull("devicePin instrumentation argument", devicePin);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        unlockWithPin(device, devicePin);
        device.executeShellCommand("am force-stop " + FIREFOX);
        context.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("fenix://settings"))
            .setPackage(FIREFOX)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        check(device, device.wait(Until.hasObject(By.pkg(FIREFOX).text("Settings")), UI_TIMEOUT_MS),
            "Firefox settings did not open");

        clickText(device, "Open links in apps");
        clickText(device, "Always");
        check(device, waitForToggle(device, "Always"), "Open links in apps is not Always");
        device.pressBack();
        device.waitForIdle();

        clickText(device, "About Firefox");
        UiObject2 logo = device.wait(Until.findObject(By.res(FIREFOX, "wordmark")), UI_TIMEOUT_MS);
        assertNotNull("About Firefox logo not found; on screen: " + visibleLabels(device), logo);
        for (int i = 0; i < 5; i++) {
            logo.click();
            device.waitForIdle();
        }
        device.pressBack();
        device.waitForIdle();

        clickText(device, "Secret Settings");
        UiObject2 title = findText(device, THIRD_PARTY_CA, UI_TIMEOUT_MS);
        assertNotNull("Secret Settings has no " + THIRD_PARTY_CA + "; on screen: " + visibleLabels(device), title);
        UiObject2 toggle = toggleOf(title);
        assertNotNull(THIRD_PARTY_CA + " has no switch; on screen: " + visibleLabels(device), toggle);
        // The row toggles on every tap, so it is tapped only while off.
        if (!toggle.isChecked()) {
            title.click();
            device.waitForIdle();
        }
        check(device, waitForToggle(device, THIRD_PARTY_CA), THIRD_PARTY_CA + " is still off");

        device.executeShellCommand("am force-stop " + FIREFOX);
        Log.i("AuthTabAcceptance", "firefoxThirdPartyCaEnabled=true firefoxOpenLinksInApps=always");
    }

    // The screen is read only on failure, after the wait, so the message shows what the wait ended on.
    private static void check(UiDevice device, boolean ok, String failure) {
        if (!ok) throw new AssertionError(failure + "; on screen: " + visibleLabels(device));
    }

    // A preference row holds its title and its switch or radio button; the list itself is never searched.
    private static UiObject2 toggleOf(UiObject2 title) {
        UiObject2 row = title;
        for (int depth = 0; depth < 4 && row != null && !row.isScrollable(); depth++) {
            UiObject2 toggle = row.findObject(By.checkable(true));
            if (toggle != null) return toggle;
            row = row.getParent();
        }
        return null;
    }

    // Preference lists rebind their rows after a change, so the row is found again on every poll.
    private static boolean waitForToggle(UiDevice device, String text) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(UI_TIMEOUT_MS);
        while (System.nanoTime() < deadline) {
            try {
                UiObject2 title = device.findObject(label(text));
                UiObject2 toggle = title == null ? null : toggleOf(title);
                if (toggle != null && toggle.isChecked()) return true;
            } catch (StaleObjectException stale) {
                // Rebound mid-read; the next poll reads the new row.
            }
            device.waitForWindowUpdate(FIREFOX, 500);
        }
        return false;
    }
}
