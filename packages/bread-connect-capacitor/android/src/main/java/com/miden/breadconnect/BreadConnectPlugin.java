package com.miden.breadconnect;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

/** Opens Bread's request links in Bread only, or Bread's Play Store page when Bread is not installed. */
@CapacitorPlugin(name = "BreadConnect")
public class BreadConnectPlugin extends Plugin {

    static final String BREAD_PACKAGE = NativeOpenAttempt.BREAD_PACKAGE;
    static final String REQUEST_PREFIX = NativeOpenAttempt.REQUEST_PREFIX;
    static final String MARKET_URL = NativeOpenAttempt.MARKET_URL;
    static final String PLAY_URL = NativeOpenAttempt.PLAY_URL;
    /** SHA-256 fingerprints of the certificates Bread is signed with, as bread.miden.xyz/.well-known/assetlinks.json lists them. */
    static final String[] BREAD_CERTIFICATES = {
        // The upload key, which signs release builds; only a build installed directly still carries it.
        "36:C8:B0:3B:C5:5D:45:19:64:A7:41:D4:36:C7:B4:7F:CC:AA:D9:A2:44:20:E1:DE:05:7A:8F:64:03:61:6D:29",
        // Google Play's app signing key, with which Google Play re-signs every install it serves.
        "8B:C9:95:6B:54:07:27:1C:3B:97:A2:38:29:5D:A4:72:9E:1A:85:BB:39:1F:D7:D2:8C:74:5E:74:D2:12:B8:2D"
    };

    private final Handler expiryHandler = new Handler(Looper.getMainLooper());
    private final NativeOpenAttempt attempts = new NativeOpenAttempt(
        new NativeOpenAttempt.IO() {
            public boolean isBread() {
                return BreadConnectPlugin.this.isBread(getContext().getPackageManager());
            }
            public boolean start(String link, String targetPackage) {
                return BreadConnectPlugin.this.start(link, targetPackage);
            }
        },
        (delay, action) -> {
            expiryHandler.postDelayed(action, delay);
            return () -> expiryHandler.removeCallbacks(action);
        }
    );

    @Override
    protected void handleOnDestroy() {
        attempts.closeAll();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void openWallet(PluginCall call) {
        String link = call.getString("url");
        if (link == null || !link.startsWith(REQUEST_PREFIX)) {
            call.reject("The link is not a Bread request link");
            return;
        }
        boolean opened = attempts.openWallet(link);
        JSObject result = new JSObject();
        result.put("opened", opened);
        call.resolve(result);
    }

    @PluginMethod
    public void prepareOpen(PluginCall call) {
        String id = attempts.prepare(call.getString("url"));
        if (id == null) {
            call.reject("The link is not a Bread request link");
            return;
        }
        JSObject result = new JSObject();
        result.put("attemptId", id);
        call.resolve(result);
    }

    @PluginMethod
    public void openStep(PluginCall call) {
        String id = call.getString("attemptId");
        String step = call.getString("step");
        if (id == null || !("wallet".equals(step) || "primaryStore".equals(step) || "secondaryStore".equals(step))) {
            call.reject("The native open step is invalid");
            return;
        }
        NativeOpenAttempt.Result opened = attempts.openStep(id, step);
        JSObject result = new JSObject();
        result.put("opened", opened.opened);
        if (opened.next != null) {
            result.put("next", opened.next);
        }
        if (opened.cancelled) {
            result.put("cancelled", true);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void revokeOpen(PluginCall call) {
        attempts.revoke(call.getString("attemptId"));
        call.resolve();
    }

    private boolean start(String link, String targetPackage) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(link)).addCategory(Intent.CATEGORY_BROWSABLE);
        if (targetPackage != null) {
            intent.setPackage(targetPackage);
        }
        try {
            getActivity().startActivity(intent);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }

    /** True when com.miden.wallet is installed and signed only with Bread's certificates, so no other app takes the request. */
    private boolean isBread(PackageManager packageManager) {
        String[] fingerprints = getConfig().getArray("signingCertificates", BREAD_CERTIFICATES);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            for (String fingerprint : fingerprints) {
                byte[] certificate = fromHex(fingerprint);
                if (
                    certificate != null &&
                    packageManager.hasSigningCertificate(BREAD_PACKAGE, certificate, PackageManager.CERT_INPUT_SHA256)
                ) {
                    return true;
                }
            }
            return false;
        }
        try {
            @SuppressWarnings("deprecation")
            Signature[] signatures = packageManager.getPackageInfo(BREAD_PACKAGE, PackageManager.GET_SIGNATURES).signatures;
            if (signatures == null || signatures.length == 0) {
                return false;
            }
            for (Signature signature : signatures) {
                if (!isListed(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()), fingerprints)) {
                    return false;
                }
            }
            return true;
        } catch (PackageManager.NameNotFoundException | NoSuchAlgorithmException e) {
            return false;
        }
    }

    static boolean isListed(byte[] digest, String[] fingerprints) {
        for (String fingerprint : fingerprints) {
            if (Arrays.equals(digest, fromHex(fingerprint))) {
                return true;
            }
        }
        return false;
    }

    /** The 32 bytes of a SHA-256 fingerprint written as hex, with or without colons; null when it is not one. */
    static byte[] fromHex(String fingerprint) {
        String hex = fingerprint.replace(":", "");
        if (hex.length() != 64) {
            return null;
        }
        byte[] bytes = new byte[32];
        for (int i = 0; i < 32; i++) {
            int high = Character.digit(hex.charAt(2 * i), 16);
            int low = Character.digit(hex.charAt(2 * i + 1), 16);
            if (high < 0 || low < 0) {
                return null;
            }
            bytes[i] = (byte) ((high << 4) | low);
        }
        return bytes;
    }
}
