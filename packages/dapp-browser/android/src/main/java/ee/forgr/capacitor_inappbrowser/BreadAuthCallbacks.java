package ee.forgr.capacitor_inappbrowser;

import android.content.Intent;

public final class BreadAuthCallbacks {
    private BreadAuthCallbacks() {}

    public static boolean forwardsToHost() { return !BreadAuthController.authTabInFlight(); }

    // A VIEW intent whose data has the scheme com.miden.wallet.auth (ASCII case-insensitive): hands the data string to the
    // open sheet, if any, and returns a copy without data. Any other intent comes back unchanged, as the same object.
    public static Intent consume(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return intent;
        String data = intent.getDataString();
        if (data == null || data.indexOf(':') != BreadAuthState.CALLBACK_SCHEME.length()
            || !BreadAuthState.startsWithIgnoringAsciiCase(data, BreadAuthState.CALLBACK_SCHEME)) return intent;
        BreadAuthController.hostCallback(data);
        return new Intent(intent).setData(null);
    }
}
