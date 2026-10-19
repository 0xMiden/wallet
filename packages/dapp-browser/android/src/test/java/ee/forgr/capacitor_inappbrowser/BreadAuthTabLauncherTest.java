package ee.forgr.capacitor_inappbrowser;

import android.content.Intent;
import android.net.Uri;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultRegistry;
import androidx.activity.result.contract.ActivityResultContract;
import androidx.browser.auth.AuthTabIntent;
import androidx.core.app.ActivityOptionsCompat;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BreadAuthTabLauncherTest {
    private static final String CALLBACK = "com.miden.wallet.auth://callback?origin=https%3A%2F%2Ffixture.example&login=a%2Fb&x=1";
    private final RecordingRegistry registry = new RecordingRegistry();
    private final List<AuthTabIntent.AuthResult> results = new ArrayList<>();
    private final List<BreadAuthTabLauncher> launchers = new ArrayList<>();
    private final List<ComponentActivity> hosts = new ArrayList<>();
    private Intent launched;
    private int requestCode;

    @After public void tearDown() {
        for (BreadAuthTabLauncher launcher : launchers) launcher.close();
        for (ComponentActivity host : hosts) host.finish();
    }

    private BreadAuthTabLauncher newLauncher() {
        BreadAuthTabLauncher launcher = new BreadAuthTabLauncher(registry, results::add);
        launchers.add(launcher);
        return launcher;
    }

    private void dispatch(int code, Intent data) {
        registry.dispatchResult(requestCode, code, data);
    }

    private final class RecordingRegistry extends ActivityResultRegistry {
        @Override public <I, O> void onLaunch(int requestCode, ActivityResultContract<I, O> contract, I input,
                ActivityOptionsCompat options) {
            if (!(input instanceof Intent)) throw new AssertionError("Expected an Intent");
            launched = (Intent) input;
            BreadAuthTabLauncherTest.this.requestCode = requestCode;
        }
    }

    @Test public void launchesPinnedAuthTabWithExactUrlAndRedirectScheme() {
        BreadAuthTabLauncher launcher = newLauncher();
        String url = "https://fixture.example/auth?x=a%2Fb&state=s+#f";
        launcher.launch("com.android.chrome", url);
        assertEquals(url, launched.getDataString());
        assertEquals("com.android.chrome", launched.getPackage());
        assertTrue(launched.getBooleanExtra(AuthTabIntent.EXTRA_LAUNCH_AUTH_TAB, false));
        assertEquals("com.miden.wallet.auth", launched.getStringExtra(AuthTabIntent.EXTRA_REDIRECT_SCHEME));
        assertFalse(launched.hasExtra(AuthTabIntent.EXTRA_HTTPS_REDIRECT_HOST));
        assertFalse(launched.hasExtra(AuthTabIntent.EXTRA_HTTPS_REDIRECT_PATH));
        assertEquals(0, launched.getFlags() & (Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_HISTORY));
    }

    @Test public void realContractParsesAllAuthTabResultCodes() {
        for (int raw : new int[] {-1, 0, 2, 3, 99}) {
            results.clear();
            BreadAuthTabLauncher launcher = newLauncher();
            launcher.launch("com.android.chrome", "https://fixture.example/auth");
            dispatch(raw, new Intent().setData(Uri.parse(CALLBACK)));
            assertEquals(1, results.size());
            assertEquals(raw == 99 ? AuthTabIntent.RESULT_UNKNOWN_CODE : raw, results.get(0).resultCode);
            assertEquals(raw == AuthTabIntent.RESULT_OK ? Uri.parse(CALLBACK) : null, results.get(0).resultUri);
            launcher.close();
        }
    }

    @Test public void closingUnregistersAndOldResultCannotReachANewLaunch() {
        BreadAuthTabLauncher old = newLauncher();
        old.launch("com.android.chrome", "https://fixture.example/auth");
        int oldCode = requestCode;
        old.close(); old.close();
        BreadAuthTabLauncher next = newLauncher();
        next.launch("com.android.chrome", "https://fixture.example/auth");
        assertNotEquals(oldCode, requestCode);
        registry.dispatchResult(oldCode, AuthTabIntent.RESULT_OK, new Intent().setData(Uri.parse(CALLBACK)));
        assertTrue(results.isEmpty());
        dispatch(AuthTabIntent.RESULT_OK, new Intent().setData(Uri.parse(CALLBACK)));
        assertEquals(1, results.size());
        next.close();
    }

    @Test public void registersAndLaunchesAfterHostIsAlreadyResumed() {
        ComponentActivity host = Robolectric.buildActivity(ComponentActivity.class).setup().visible().get();
        hosts.add(host);
        BreadAuthTabLauncher launcher = new BreadAuthTabLauncher(host.getActivityResultRegistry(), results::add);
        launchers.add(launcher);
        launcher.launch("com.android.chrome", "https://fixture.example/auth");
        assertNotNull(shadowOf(host).getNextStartedActivityForResult());
        launcher.close(); host.finish();
    }
}
