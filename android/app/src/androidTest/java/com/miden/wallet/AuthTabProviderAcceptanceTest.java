package com.miden.wallet;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.util.Log;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Assert;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * A fixed provider pair exercises both branches; a moving browser selection
 * could leave one Auth Tab path untested in an otherwise green run.
 */
@RunWith(AndroidJUnit4.class)
public class AuthTabProviderAcceptanceTest {
    @Test
    public void installedProvidersExposeExpectedCapabilities() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String expectedProvider = InstrumentationRegistry.getArguments().getString("expectedProvider");
        Assert.assertNotNull("expectedProvider instrumentation argument", expectedProvider);
        String authTabProvider = InstrumentationRegistry.getArguments().getString("authTabProvider");
        Assert.assertNotNull("authTabProvider instrumentation argument", authTabProvider);
        String selectedProvider = CustomTabsClient.getPackageName(context, null);
        Assert.assertEquals("selected Custom Tabs provider", expectedProvider, selectedProvider);
        assertProvider(context, authTabProvider, true);
        assertProvider(context, "org.mozilla.firefox", false);
        PackageInfo selectedInfo = context.getPackageManager().getPackageInfo(
            selectedProvider, PackageManager.GET_META_DATA);
        Log.i("AuthTabAcceptance", "selectedProvider=" + selectedProvider + " version="
            + selectedInfo.versionName + " authTabSupported="
            + CustomTabsClient.isAuthTabSupported(context, selectedProvider));
    }

    private void assertProvider(Context context, String packageName, boolean expected) throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(packageName, PackageManager.GET_META_DATA);
        boolean supported = CustomTabsClient.isAuthTabSupported(context, packageName);
        Log.i("AuthTabAcceptance", "provider=" + packageName + " version=" + info.versionName
            + " authTabSupported=" + supported);
        assertEquals(packageName + " Auth Tab capability", expected, supported);
    }
}
