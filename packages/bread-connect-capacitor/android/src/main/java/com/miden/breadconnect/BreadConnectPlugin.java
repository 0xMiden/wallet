package com.miden.breadconnect;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
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

    static final String BREAD_PACKAGE = "com.miden.wallet";
    static final String REQUEST_PREFIX = "https://bread.miden.xyz/request#";
    static final String MARKET_URL = "market://details?id=" + BREAD_PACKAGE;
    static final String PLAY_URL = "https://play.google.com/store/apps/details?id=" + BREAD_PACKAGE;
    /** SHA-256 fingerprints of the certificates Bread is signed with, as bread.miden.xyz/.well-known/assetlinks.json lists them. */
    static final String[] BREAD_CERTIFICATES = {
        "36:C8:B0:3B:C5:5D:45:19:64:A7:41:D4:36:C7:B4:7F:CC:AA:D9:A2:44:20:E1:DE:05:7A:8F:64:03:61:6D:29"
    };

    @PluginMethod
    public void openWallet(PluginCall call) {
        String link = call.getString("url");
        if (link == null || !link.startsWith(REQUEST_PREFIX)) {
            call.reject("The link is not a Bread request link");
            return;
        }
        boolean opened = isBread(getContext().getPackageManager()) && start(link, BREAD_PACKAGE);
        if (!opened && !start(MARKET_URL, null)) {
            start(PLAY_URL, null);
        }
        JSObject result = new JSObject();
        result.put("opened", opened);
        call.resolve(result);
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
