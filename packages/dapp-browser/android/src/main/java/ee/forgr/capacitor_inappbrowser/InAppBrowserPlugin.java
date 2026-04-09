package ee.forgr.capacitor_inappbrowser;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.browser.customtabs.CustomTabsCallback;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.browser.customtabs.CustomTabsServiceConnection;
import androidx.browser.customtabs.CustomTabsSession;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import ee.forgr.capacitor_inappbrowser.navbar.NavbarOverlayManager;
import ee.forgr.capacitor_inappbrowser.navbar.NavbarState;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "InAppBrowser",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    },
    requestCodes = { WebViewDialog.FILE_CHOOSER_REQUEST_CODE }
)
public class InAppBrowserPlugin extends Plugin implements WebViewDialog.PermissionHandler {

    private final String pluginVersion = "8.0.6";

    public static final String CUSTOM_TAB_PACKAGE_NAME = "com.android.chrome"; // Change when in stable
    private CustomTabsClient customTabsClient;
    private CustomTabsSession currentSession;
    private WebViewDialog webViewDialog = null;
    private String currentUrl = "";

    private PermissionRequest currentPermissionRequest;

    private ActivityResultLauncher<Intent> fileChooserLauncher;

    // Miden patch — Android port of iOS MidenNavbarOverlayWindow.
    // Lazily-initialized the first time a native navbar plugin method
    // is called (showNativeNavbar). Owns the NavbarStateHolder, all
    // NavbarView instances (Activity + Dialog-scoped), and the
    // re-parenting arbitration logic.
    private NavbarOverlayManager navbarManager;

    @Override
    public void load() {
        super.load();
        fileChooserLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            this::handleFileChooserResult
        );
    }

    /**
     * Lazily construct the navbar manager on the UI thread. Every
     * navbar plugin method funnels through this to avoid races where
     * multiple JS calls land before the manager has been created.
     */
    private NavbarOverlayManager getOrCreateNavbarManager() {
        if (navbarManager == null) {
            navbarManager = new NavbarOverlayManager(getActivity());
            navbarManager.setTapCallback(
                new NavbarOverlayManager.TapCallback() {
                    @Override
                    public void onItemTap(String id) {
                        JSObject data = new JSObject();
                        data.put("id", id);
                        notifyListeners("nativeNavbarTap", data);
                    }

                    @Override
                    public void onSecondaryTap(String id) {
                        JSObject data = new JSObject();
                        data.put("id", id);
                        notifyListeners("nativeNavbarSecondaryTap", data);
                    }

                    @Override
                    public void onActionTap() {
                        notifyListeners("nativeNavbarActionTap", new JSObject());
                    }
                }
            );
        }
        return navbarManager;
    }

    /**
     * Parse a JS array of {@code {id, title, sfSymbol}} objects into
     * {@link NavbarState.Item} instances. The iOS side uses
     * {@code sfSymbol} for the icon name; on Android we reuse the
     * same field but look up an Android drawable by a matching name
     * mapping (nav_home, nav_activity, nav_browser, nav_send, etc).
     */
    private java.util.List<NavbarState.Item> decodeNavbarItems(JSArray raw) throws JSONException {
        java.util.List<NavbarState.Item> out = new java.util.ArrayList<>();
        if (raw == null) return out;
        for (int i = 0; i < raw.length(); i++) {
            JSONObject obj = raw.getJSONObject(i);
            String id = obj.optString("id", null);
            String title = obj.optString("title", "");
            // Both "sfSymbol" and "iconDrawableName" are accepted so
            // the JS side can keep sending iOS-style SF Symbol names
            // and the Android Java side will map them to local
            // drawables at bind time.
            String icon = obj.optString("sfSymbol", null);
            if (icon == null) icon = obj.optString("iconDrawableName", null);
            if (id == null) continue;
            out.add(new NavbarState.Item(id, title, icon));
        }
        return out;
    }

    @PluginMethod
    public void showNativeNavbar(PluginCall call) {
        final JSArray itemsRaw = call.getArray("items");
        if (itemsRaw == null) {
            call.reject("items array is required");
            return;
        }
        final String activeId = call.getString("activeId");
        this.getActivity().runOnUiThread(
            () -> {
                try {
                    java.util.List<NavbarState.Item> items = decodeNavbarItems(itemsRaw);
                    if (items.isEmpty()) {
                        call.reject("at least one item is required");
                        return;
                    }
                    getOrCreateNavbarManager().show(items, activeId);
                    call.resolve();
                } catch (Exception e) {
                    Log.e("InAppBrowser", "showNativeNavbar failed", e);
                    call.reject("showNativeNavbar failed: " + e.getMessage());
                }
            }
        );
    }

    @PluginMethod
    public void hideNativeNavbar(PluginCall call) {
        this.getActivity().runOnUiThread(
            () -> {
                if (navbarManager != null) navbarManager.hide();
                call.resolve();
            }
        );
    }

    @PluginMethod
    public void setNativeNavbarActive(PluginCall call) {
        final String id = call.getString("id");
        this.getActivity().runOnUiThread(
            () -> {
                if (navbarManager != null) navbarManager.setActive(id);
                call.resolve();
            }
        );
    }

    @PluginMethod
    public void setNavbarSecondaryRow(PluginCall call) {
        final JSArray itemsRaw = call.getArray("items");
        final String activeId = call.getString("activeId");
        this.getActivity().runOnUiThread(
            () -> {
                try {
                    java.util.List<NavbarState.Item> items = decodeNavbarItems(itemsRaw);
                    getOrCreateNavbarManager().setSecondaryItems(items, activeId);
                    call.resolve();
                } catch (Exception e) {
                    Log.e("InAppBrowser", "setNavbarSecondaryRow failed", e);
                    call.reject("setNavbarSecondaryRow failed: " + e.getMessage());
                }
            }
        );
    }

    @PluginMethod
    public void setNavbarAction(PluginCall call) {
        final String label = call.getString("label");
        if (label == null) {
            call.reject("label is required");
            return;
        }
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        this.getActivity().runOnUiThread(
            () -> {
                getOrCreateNavbarManager().setAction(label, enabled);
                call.resolve();
            }
        );
    }

    @PluginMethod
    public void clearNavbarAction(PluginCall call) {
        this.getActivity().runOnUiThread(
            () -> {
                if (navbarManager != null) navbarManager.clearAction();
                call.resolve();
            }
        );
    }

    @PluginMethod
    public void morphNavbarOut(PluginCall call) {
        this.getActivity().runOnUiThread(
            () -> {
                if (navbarManager != null) navbarManager.morphOut();
                call.resolve();
            }
        );
    }

    @PluginMethod
    public void morphNavbarIn(PluginCall call) {
        this.getActivity().runOnUiThread(
            () -> {
                if (navbarManager != null) navbarManager.morphIn();
                call.resolve();
            }
        );
    }

    private void handleFileChooserResult(ActivityResult result) {
        if (webViewDialog != null && webViewDialog.mFilePathCallback != null) {
            Uri[] results = null;
            Intent data = result.getData();

            if (result.getResultCode() == Activity.RESULT_OK) {
                // Handle camera capture result
                if (webViewDialog.tempCameraUri != null && (data == null || data.getData() == null)) {
                    results = new Uri[] { webViewDialog.tempCameraUri };
                }
                // Handle regular file picker result
                else if (data != null) {
                    if (data.getClipData() != null) {
                        // Handle multiple files
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        // Handle single file
                        results = new Uri[] { data.getData() };
                    }
                }
            }

            // Send the result to WebView and clean up
            webViewDialog.mFilePathCallback.onReceiveValue(results);
            webViewDialog.mFilePathCallback = null;
            webViewDialog.tempCameraUri = null;
        }
    }

    public void handleMicrophonePermissionRequest(PermissionRequest request) {
        this.currentPermissionRequest = request;
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", null, "microphonePermissionCallback");
        } else {
            grantMicrophonePermission();
        }
    }

    private void grantMicrophonePermission() {
        if (currentPermissionRequest != null) {
            currentPermissionRequest.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            currentPermissionRequest = null;
        }
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            grantCameraAndMicrophonePermission();
        } else {
            if (currentPermissionRequest != null) {
                currentPermissionRequest.deny();
                currentPermissionRequest = null;
            }
            if (call != null) {
                call.reject("Microphone permission is required");
            }
        }
    }

    private void grantCameraAndMicrophonePermission() {
        if (currentPermissionRequest != null) {
            currentPermissionRequest.grant(
                new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE, PermissionRequest.RESOURCE_AUDIO_CAPTURE }
            );
            currentPermissionRequest = null;
        }
    }

    public void handleCameraPermissionRequest(PermissionRequest request) {
        this.currentPermissionRequest = request;
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", null, "cameraPermissionCallback");
        } else if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", null, "microphonePermissionCallback");
        } else {
            grantCameraAndMicrophonePermission();
        }
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                requestPermissionForAlias("microphone", null, "microphonePermissionCallback");
            } else {
                grantCameraAndMicrophonePermission();
            }
        } else {
            if (currentPermissionRequest != null) {
                currentPermissionRequest.deny();
                currentPermissionRequest = null;
            }

            // Reject only if there's a call - could be null for WebViewDialog flow
            if (call != null) {
                call.reject("Camera permission is required");
            }
        }
    }

    @PermissionCallback
    private void cameraPermissionCallback() {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            grantCameraPermission();
        } else {
            if (currentPermissionRequest != null) {
                currentPermissionRequest.deny();
                currentPermissionRequest = null;
            }
        }
    }

    private void grantCameraPermission() {
        if (currentPermissionRequest != null) {
            currentPermissionRequest.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
            currentPermissionRequest = null;
        }
    }

    CustomTabsServiceConnection connection = new CustomTabsServiceConnection() {
        @Override
        public void onCustomTabsServiceConnected(ComponentName name, CustomTabsClient client) {
            customTabsClient = client;
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            customTabsClient = null;
        }
    };

    @PluginMethod
    public void requestCameraPermission(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
        } else {
            call.resolve();
        }
    }

    @PluginMethod
    public void setUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || TextUtils.isEmpty(url)) {
            call.reject("Invalid URL");
            return;
        }

        // Miden patch (PR-4 chunk 7): id-aware routing.
        final String instanceId = call.getString("id") != null
            ? call.getString("id")
            : WebViewRegistry.DEFAULT_INSTANCE_ID;
        final WebViewDialog target = WebViewRegistry.getShared().get(instanceId);
        if (target == null && webViewDialog == null) {
            call.reject("WebView is not initialized");
            return;
        }

        currentUrl = url;
        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    try {
                        WebViewDialog dialog = target != null ? target : webViewDialog;
                        if (dialog != null) {
                            dialog.setUrl(url);
                            call.resolve();
                        } else {
                            call.reject("WebView is not initialized");
                        }
                    } catch (Exception e) {
                        Log.e("InAppBrowser", "Error setting URL: " + e.getMessage());
                        call.reject("Failed to set URL: " + e.getMessage());
                    }
                }
            }
        );
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("URL is required");
            return;
        }

        // get the deeplink prevention, if provided
        Boolean preventDeeplink = call.getBoolean("preventDeeplink", false);
        Boolean isPresentAfterPageLoad = call.getBoolean("isPresentAfterPageLoad", false);

        if (url == null || TextUtils.isEmpty(url)) {
            call.reject("Invalid URL");
        }
        currentUrl = url;
        CustomTabsIntent.Builder builder = new CustomTabsIntent.Builder(getCustomTabsSession());
        CustomTabsIntent tabsIntent = builder.build();
        tabsIntent.intent.putExtra(Intent.EXTRA_REFERRER, Uri.parse(Intent.URI_ANDROID_APP_SCHEME + "//" + getContext().getPackageName()));
        tabsIntent.intent.putExtra(android.provider.Browser.EXTRA_HEADERS, this.getHeaders(call));

        if (preventDeeplink != false) {
            String browserPackageName = "";
            Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse("http://"));
            ResolveInfo resolveInfo = getContext().getPackageManager().resolveActivity(browserIntent, PackageManager.MATCH_DEFAULT_ONLY);

            if (resolveInfo != null) {
                browserPackageName = resolveInfo.activityInfo.packageName;

                if (!browserPackageName.isEmpty()) {
                    tabsIntent.intent.setPackage(browserPackageName);
                }
            }
        }

        if (isPresentAfterPageLoad) {
            tabsIntent.intent.putExtra("isPresentAfterPageLoad", true);
        }

        tabsIntent.launchUrl(getContext(), Uri.parse(url));

        call.resolve();
    }

    @PluginMethod
    public void clearCache(PluginCall call) {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.removeAllCookies(null);
        cookieManager.flush();
        call.resolve();
    }

    @PluginMethod
    public void clearAllCookies(PluginCall call) {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.removeAllCookies(null);
        cookieManager.flush();
        call.resolve();
    }

    @PluginMethod
    public void clearCookies(PluginCall call) {
        String url = call.getString("url", currentUrl);
        if (url == null || TextUtils.isEmpty(url)) {
            call.reject("Invalid URL");
            return;
        }

        Uri uri = Uri.parse(url);
        String host = uri.getHost();
        if (host == null || TextUtils.isEmpty(host)) {
            call.reject("Invalid URL (Host is null)");
            return;
        }

        CookieManager cookieManager = CookieManager.getInstance();
        String cookieString = cookieManager.getCookie(url);
        ArrayList<String> cookiesToRemove = new ArrayList<>();

        if (cookieString != null) {
            String[] cookies = cookieString.split("; ");

            String domain = uri.getHost();

            for (String cookie : cookies) {
                String[] parts = cookie.split("=");
                if (parts.length > 0) {
                    cookiesToRemove.add(parts[0].trim());
                    CookieManager.getInstance().setCookie(url, String.format("%s=del;", parts[0].trim()));
                }
            }
        }

        StringBuilder scriptToRun = new StringBuilder();
        for (String cookieToRemove : cookiesToRemove) {
            scriptToRun.append(
                String.format("window.cookieStore.delete('%s', {name: '%s', domain: '%s'});", cookieToRemove, cookieToRemove, url)
            );
        }

        Log.i("DelCookies", String.format("Script to run:\n%s", scriptToRun));

        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    try {
                        if (webViewDialog != null) {
                            webViewDialog.executeScript(scriptToRun.toString());
                            call.resolve();
                        } else {
                            call.reject("WebView is not initialized");
                        }
                    } catch (Exception e) {
                        Log.e("InAppBrowser", "Error clearing cookies: " + e.getMessage());
                        call.reject("Failed to clear cookies: " + e.getMessage());
                    }
                }
            }
        );
    }

    @PluginMethod
    public void getCookies(PluginCall call) {
        String url = call.getString("url");
        if (url == null || TextUtils.isEmpty(url)) {
            call.reject("Invalid URL");
            return;
        }
        CookieManager cookieManager = CookieManager.getInstance();
        String cookieString = cookieManager.getCookie(url);
        JSObject result = new JSObject();
        if (cookieString != null) {
            String[] cookiePairs = cookieString.split("; ");
            for (String cookie : cookiePairs) {
                String[] parts = cookie.split("=", 2);
                if (parts.length == 2) {
                    result.put(parts[0], parts[1]);
                }
            }
        }
        call.resolve(result);
    }

    @PluginMethod
    public void openWebView(PluginCall call) {
        String url = call.getString("url");
        if (url == null || TextUtils.isEmpty(url)) {
            call.reject("Invalid URL");
        }
        currentUrl = url;
        final Options options = new Options();
        options.setUrl(url);
        options.setHeaders(call.getObject("headers"));
        options.setCredentials(call.getObject("credentials"));
        options.setShowReloadButton(Boolean.TRUE.equals(call.getBoolean("showReloadButton", false)));
        options.setVisibleTitle(Boolean.TRUE.equals(call.getBoolean("visibleTitle", true)));
        if (Boolean.TRUE.equals(options.getVisibleTitle())) {
            options.setTitle(call.getString("title", "New Window"));
        } else {
            options.setTitle(call.getString("title", ""));
        }
        options.setToolbarColor(call.getString("toolbarColor", "#ffffff"));
        options.setBackgroundColor(call.getString("backgroundColor", "white"));
        options.setToolbarTextColor(call.getString("toolbarTextColor"));
        options.setArrow(Boolean.TRUE.equals(call.getBoolean("showArrow", false)));
        options.setIgnoreUntrustedSSLError(Boolean.TRUE.equals(call.getBoolean("ignoreUntrustedSSLError", false)));

        // Set text zoom if specified in options (default is 100)
        Integer textZoom = call.getInt("textZoom");
        if (textZoom != null) {
            options.setTextZoom(textZoom);
        }

        String proxyRequestsStr = call.getString("proxyRequests");
        if (proxyRequestsStr != null) {
            try {
                options.setProxyRequestsPattern(Pattern.compile(proxyRequestsStr));
            } catch (PatternSyntaxException e) {
                Log.e("WebViewDialog", String.format("Pattern '%s' is not a valid pattern", proxyRequestsStr));
            }
        }

        try {
            // Try to set buttonNearDone if present, with better error handling
            JSObject buttonNearDoneObj = call.getObject("buttonNearDone");
            if (buttonNearDoneObj != null) {
                try {
                    // Provide better debugging for buttonNearDone
                    JSObject androidObj = buttonNearDoneObj.getJSObject("android");
                    if (androidObj != null) {
                        String iconType = androidObj.getString("iconType", "asset");
                        String icon = androidObj.getString("icon", "");
                        Log.d("InAppBrowser", "ButtonNearDone config - iconType: " + iconType + ", icon: " + icon);

                        // For vector type, verify if resource exists
                        if ("vector".equals(iconType)) {
                            int resourceId = getContext().getResources().getIdentifier(icon, "drawable", getContext().getPackageName());
                            if (resourceId == 0) {
                                Log.e("InAppBrowser", "Vector resource not found: " + icon);
                                // List available drawable resources to help debugging
                                try {
                                    final StringBuilder availableResources = getStringBuilder();
                                    Log.d("InAppBrowser", availableResources.toString());
                                } catch (Exception e) {
                                    Log.e("InAppBrowser", "Error listing resources: " + e.getMessage());
                                }
                            } else {
                                Log.d("InAppBrowser", "Vector resource found with ID: " + resourceId);
                            }
                        }
                    }

                    // Try to create the ButtonNearDone object
                    Options.ButtonNearDone buttonNearDone = Options.ButtonNearDone.generateFromPluginCall(call, getContext().getAssets());
                    options.setButtonNearDone(buttonNearDone);
                } catch (Exception e) {
                    Log.e("InAppBrowser", "Error setting buttonNearDone: " + e.getMessage(), e);
                }
            }
        } catch (Exception e) {
            Log.e("InAppBrowser", "Error processing buttonNearDone: " + e.getMessage(), e);
        }

        options.setShareDisclaimer(call.getObject("shareDisclaimer", null));
        options.setPreShowScript(call.getString("preShowScript", null));
        options.setShareSubject(call.getString("shareSubject", null));
        options.setToolbarType(call.getString("toolbarType", ""));
        options.setPreventDeeplink(Boolean.TRUE.equals(call.getBoolean("preventDeeplink", false)));

        // Validate preShowScript requires isPresentAfterPageLoad
        if (call.getData().has("preShowScript") && !Boolean.TRUE.equals(call.getBoolean("isPresentAfterPageLoad", false))) {
            call.reject("preShowScript requires isPresentAfterPageLoad to be true");
            return;
        }

        // Validate closeModal options
        if (Boolean.TRUE.equals(call.getBoolean("closeModal", false))) {
            options.setCloseModal(true);
            options.setCloseModalTitle(call.getString("closeModalTitle", "Close"));
            options.setCloseModalDescription(call.getString("closeModalDescription", "Are you sure ?"));
            options.setCloseModalOk(call.getString("closeModalOk", "Ok"));
            options.setCloseModalCancel(call.getString("closeModalCancel", "Cancel"));
        } else {
            // Reject if closeModal is false but closeModal options are provided
            if (
                call.getData().has("closeModalTitle") ||
                call.getData().has("closeModalDescription") ||
                call.getData().has("closeModalOk") ||
                call.getData().has("closeModalCancel")
            ) {
                call.reject("closeModal options require closeModal to be true");
                return;
            }
            options.setCloseModal(false);
        }

        // Validate shareDisclaimer requires shareSubject
        if (call.getData().has("shareDisclaimer") && !call.getData().has("shareSubject")) {
            call.reject("shareDisclaimer requires shareSubject to be provided");
            return;
        }

        // Validate buttonNearDone compatibility with toolbar type
        if (call.getData().has("buttonNearDone")) {
            String toolbarType = options.getToolbarType();
            if (
                TextUtils.equals(toolbarType, "activity") ||
                TextUtils.equals(toolbarType, "navigation") ||
                TextUtils.equals(toolbarType, "blank")
            ) {
                call.reject("buttonNearDone is not compatible with toolbarType: " + toolbarType);
                return;
            }
        }

        options.setActiveNativeNavigationForWebview(Boolean.TRUE.equals(call.getBoolean("activeNativeNavigationForWebview", false)));
        options.setDisableGoBackOnNativeApplication(Boolean.TRUE.equals(call.getBoolean("disableGoBackOnNativeApplication", false)));
        options.setPresentAfterPageLoad(Boolean.TRUE.equals(call.getBoolean("isPresentAfterPageLoad", false)));
        options.setPluginCall(call);

        // Set Material Design picker option
        options.setMaterialPicker(Boolean.TRUE.equals(call.getBoolean("materialPicker", false)));

        // Set enabledSafeBottomMargin option
        options.setEnabledSafeMargin(Boolean.TRUE.equals(call.getBoolean("enabledSafeBottomMargin", false)));

        // Use system top inset for WebView margin when explicitly enabled
        options.setUseTopInset(Boolean.TRUE.equals(call.getBoolean("useTopInset", false)));

        // Miden patch (PR-4 chunk 7): the callback closure needs to capture
        // the instance id so every event the WebView emits is tagged with the
        // id of the originating instance. The JS-side multi-instance handler
        // uses this to route events to the matching session. We capture the
        // id later (after instanceId is computed below) by holding a final
        // reference here that callbacks can read.
        final String[] callbackInstanceId = new String[] { WebViewRegistry.DEFAULT_INSTANCE_ID };

        //    options.getToolbarItemTypes().add(ToolbarItemType.RELOAD); TODO: fix this
        options.setCallbacks(
            new WebViewCallbacks() {
                @Override
                public void urlChangeEvent(String url) {
                    notifyListeners(
                        "urlChangeEvent",
                        new JSObject().put("url", url).put("id", callbackInstanceId[0])
                    );
                }

                @Override
                public void closeEvent(String url) {
                    notifyListeners(
                        "closeEvent",
                        new JSObject().put("url", url).put("id", callbackInstanceId[0])
                    );
                }

                @Override
                public void pageLoaded() {
                    notifyListeners(
                        "browserPageLoaded",
                        new JSObject().put("id", callbackInstanceId[0])
                    );
                }

                @Override
                public void pageLoadError() {
                    notifyListeners(
                        "pageLoadError",
                        new JSObject().put("id", callbackInstanceId[0])
                    );
                }

                @Override
                public void buttonNearDoneClicked() {
                    notifyListeners(
                        "buttonNearDoneClick",
                        new JSObject().put("id", callbackInstanceId[0])
                    );
                }

                @Override
                public void confirmBtnClicked(String url) {
                    notifyListeners(
                        "confirmBtnClicked",
                        new JSObject().put("url", url).put("id", callbackInstanceId[0])
                    );
                }

                @Override
                public void javascriptCallback(String message) {
                    // Handle the message received from JavaScript
                    Log.d("WebViewDialog", "Received message from JavaScript: " + message);
                    // Process the message as needed
                    try {
                        // Parse the received message as a JSON object
                        JSONObject jsonMessage = new JSONObject(message);

                        // Create a new JSObject to send to the Capacitor plugin
                        JSObject jsObject = new JSObject();

                        // Iterate through the keys in the JSON object and add them to the JSObject
                        Iterator<String> keys = jsonMessage.keys();
                        while (keys.hasNext()) {
                            String key = keys.next();
                            jsObject.put(key, jsonMessage.get(key));
                        }

                        // PR-4 chunk 7: tag the event with the originating
                        // instance id (overwrites any "id" the JS message
                        // happened to include — the native id is the source
                        // of truth for routing).
                        jsObject.put("id", callbackInstanceId[0]);

                        // Notify listeners with the parsed message
                        notifyListeners("messageFromWebview", jsObject);
                    } catch (JSONException e) {
                        Log.e("WebViewDialog", "Error parsing JSON message: " + e.getMessage());

                        // If JSON parsing fails, send the raw message as a string
                        JSObject jsObject = new JSObject();
                        jsObject.put("rawMessage", message);
                        jsObject.put("id", callbackInstanceId[0]);
                        notifyListeners("messageFromWebview", jsObject);
                    }
                }
            }
        );

        JSArray jsAuthorizedLinks = call.getArray("authorizedAppLinks");
        if (jsAuthorizedLinks != null && jsAuthorizedLinks.length() > 0) {
            List<String> authorizedLinks = new ArrayList<>();
            for (int i = 0; i < jsAuthorizedLinks.length(); i++) {
                try {
                    String link = jsAuthorizedLinks.getString(i);
                    if (link != null && !link.trim().isEmpty()) {
                        authorizedLinks.add(link);
                    }
                } catch (Exception e) {
                    Log.w("InAppBrowserPlugin", "Error reading authorized app link at index " + i, e);
                }
            }
            Log.d("InAppBrowserPlugin", "Parsed authorized app links: " + authorizedLinks);
            options.setAuthorizedAppLinks(authorizedLinks);
        } else {
            Log.d("InAppBrowserPlugin", "No authorized app links provided.");
        }

        JSArray blockedHostsRaw = call.getArray("blockedHosts");
        if (blockedHostsRaw != null && blockedHostsRaw.length() > 0) {
            List<String> blockedHosts = new ArrayList<>();
            for (int i = 0; i < blockedHostsRaw.length(); i++) {
                try {
                    String host = blockedHostsRaw.getString(i);
                    if (host != null && !host.trim().isEmpty()) {
                        blockedHosts.add(host);
                    }
                } catch (Exception e) {
                    Log.w("InAppBrowserPlugin", "Error reading blocked host at index " + i, e);
                }
            }
            Log.d("InAppBrowserPlugin", "Parsed blocked hosts: " + blockedHosts);
            options.setBlockedHosts(blockedHosts);
        } else {
            Log.d("InAppBrowserPlugin", "No blocked hosts provided.");
        }

        // Set Google Pay support option
        options.setEnableGooglePaySupport(Boolean.TRUE.equals(call.getBoolean("enableGooglePaySupport", false)));

        // Set dimensions if provided
        Integer width = call.getInt("width");
        Integer height = call.getInt("height");
        Integer x = call.getInt("x");
        Integer y = call.getInt("y");

        // Validate dimension parameters
        if (width != null && height == null) {
            call.reject("Height must be specified when width is provided");
            return;
        }

        if (width != null) {
            options.setWidth(width);
        }
        if (height != null) {
            options.setHeight(height);
        }
        if (x != null) {
            options.setX(x);
        }
        if (y != null) {
            options.setY(y);
        }

        // Miden patch (PR-4 chunk 5): read the optional id param so multi-
        // instance callers can target a specific instance. Defaults to
        // "default" for legacy single-instance callers.
        final String instanceId = call.getString("id") != null
            ? call.getString("id")
            : WebViewRegistry.DEFAULT_INSTANCE_ID;
        // Miden patch (PR-4 chunk 7): wire the id into the event callbacks so
        // every notifyListeners call from this WebView is tagged with the id.
        callbackInstanceId[0] = instanceId;

        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    webViewDialog = new WebViewDialog(
                        getContext(),
                        android.R.style.Theme_NoTitleBar,
                        options,
                        InAppBrowserPlugin.this,
                        getBridge().getWebView()
                    );
                    webViewDialog.activity = InAppBrowserPlugin.this.getActivity();

                    // Miden navbar — register show/dismiss listeners so the
                    // navbar manager can attach a Dialog-scoped NavbarView
                    // instance once the Dialog's decor view is available,
                    // and detach it on dismiss. This is the Phase 6
                    // two-instance architecture: one NavbarView lives in
                    // the Activity, another (fresh) lives inside each
                    // WebViewDialog's own Window, so the pill stays above
                    // the dApp content without any Window z-order
                    // wrestling.
                    final WebViewDialog createdDialog = webViewDialog;
                    createdDialog.setOnShowListener(
                        new android.content.DialogInterface.OnShowListener() {
                            @Override
                            public void onShow(android.content.DialogInterface d) {
                                if (navbarManager != null) {
                                    navbarManager.onDialogShown(createdDialog);
                                }
                            }
                        }
                    );
                    createdDialog.setOnDismissListener(
                        new android.content.DialogInterface.OnDismissListener() {
                            @Override
                            public void onDismiss(android.content.DialogInterface d) {
                                if (navbarManager != null) {
                                    navbarManager.onDialogDismissed(createdDialog);
                                }
                            }
                        }
                    );

                    webViewDialog.presentWebView();
                    // Mirror in the multi-instance registry. Unlike iOS,
                    // Android Dialog already supports multiple concurrent
                    // instances natively (each Dialog has its own Window),
                    // so we don't need a separate UIWindow refactor.
                    WebViewRegistry.getShared().register(instanceId, webViewDialog);
                    call.resolve();
                }
            }
        );
    }

    @NonNull
    private static StringBuilder getStringBuilder() {
        Field[] drawables = R.drawable.class.getFields();
        StringBuilder availableResources = new StringBuilder("Available resources: ");
        for (int i = 0; i < Math.min(10, drawables.length); i++) {
            availableResources.append(drawables[i].getName()).append(", ");
        }
        if (drawables.length > 10) {
            availableResources.append("... (").append(drawables.length - 10).append(" more)");
        }
        return availableResources;
    }

    @PluginMethod
    public void postMessage(PluginCall call) {
        // Miden patch (PR-4 chunk 7): id-aware. Defaults to "default" so legacy
        // single-instance callers still work.
        final String instanceId = call.getString("id") != null
            ? call.getString("id")
            : WebViewRegistry.DEFAULT_INSTANCE_ID;
        final WebViewDialog target = WebViewRegistry.getShared().get(instanceId);
        if (target == null && webViewDialog == null) {
            call.reject("WebView is not initialized");
            return;
        }
        JSObject eventData = call.getObject("detail");
        // Log event data
        if (eventData == null) {
            call.reject("No event data provided");
            return;
        }

        Log.d("InAppBrowserPlugin", "Event data: " + eventData.toString());
        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    WebViewDialog dialog = target != null ? target : webViewDialog;
                    if (dialog != null) {
                        dialog.postMessageToJS(eventData);
                        call.resolve();
                    } else {
                        call.reject("WebView is not initialized");
                    }
                }
            }
        );
    }

    @PluginMethod
    public void executeScript(PluginCall call) {
        String script = call.getString("code");
        if (script == null || script.trim().isEmpty()) {
            call.reject("Script is required");
            return;
        }

        // Miden patch (PR-4 chunk 7): id-aware routing.
        final String instanceId = call.getString("id") != null
            ? call.getString("id")
            : WebViewRegistry.DEFAULT_INSTANCE_ID;
        final WebViewDialog target = WebViewRegistry.getShared().get(instanceId);
        if (target == null && webViewDialog == null) {
            call.reject("WebView is not initialized");
            return;
        }

        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    try {
                        WebViewDialog dialog = target != null ? target : webViewDialog;
                        if (dialog != null) {
                            dialog.executeScript(script);
                            call.resolve();
                        } else {
                            call.reject("WebView is not initialized");
                        }
                    } catch (Exception e) {
                        Log.e("InAppBrowser", "Error executing script: " + e.getMessage());
                        call.reject("Failed to execute script: " + e.getMessage());
                    }
                }
            }
        );
    }

    @PluginMethod
    public void goBack(PluginCall call) {
        // Miden patch (PR-4 chunk 7): id-aware routing.
        final String instanceId = call.getString("id") != null
            ? call.getString("id")
            : WebViewRegistry.DEFAULT_INSTANCE_ID;
        final WebViewDialog target = WebViewRegistry.getShared().get(instanceId);
        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    WebViewDialog dialog = target != null ? target : webViewDialog;
                    if (dialog != null) {
                        boolean canGoBack = dialog.goBack();
                        JSObject result = new JSObject();
                        result.put("canGoBack", canGoBack);
                        call.resolve(result);
                    } else {
                        JSObject result = new JSObject();
                        result.put("canGoBack", false);
                        call.resolve(result);
                    }
                }
            }
        );
    }

    @PluginMethod
    public void reload(PluginCall call) {
        // Miden patch (PR-4 chunk 7): id-aware routing.
        final String instanceId = call.getString("id") != null
            ? call.getString("id")
            : WebViewRegistry.DEFAULT_INSTANCE_ID;
        final WebViewDialog target = WebViewRegistry.getShared().get(instanceId);
        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    WebViewDialog dialog = target != null ? target : webViewDialog;
                    if (dialog != null) {
                        dialog.reload();
                        call.resolve();
                    } else {
                        call.reject("WebView is not initialized");
                    }
                }
            }
        );
    }

    @PluginMethod
    public void lsuakdchgbbaHandleProxiedRequest(PluginCall call) {
        if (webViewDialog != null) {
            Boolean ok = call.getBoolean("ok", false);
            String id = call.getString("id");
            if (id == null) {
                Log.e("InAppBrowserProxy", "CRITICAL ERROR, proxy id = null");
                return;
            }
            if (Boolean.FALSE.equals(ok)) {
                String result = call.getString("result", "");
                webViewDialog.handleProxyResultError(result, id);
            } else {
                JSONObject object = call.getObject("result");
                webViewDialog.handleProxyResultOk(object, id);
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        // Miden patch (PR-4 chunk 5): id-aware. Defaults to "default" so
        // legacy single-instance callers still work.
        final String instanceId = call.getString("id") != null
            ? call.getString("id")
            : WebViewRegistry.DEFAULT_INSTANCE_ID;
        // For multi-instance callers, look up the dialog from the registry
        // instead of using the legacy webViewDialog field. The legacy field
        // tracks only the most recently opened dialog, which would close
        // the wrong instance for multi-instance callers.
        final WebViewDialog dialog = WebViewRegistry.getShared().get(instanceId);
        final boolean isLegacyDefault = instanceId.equals(WebViewRegistry.DEFAULT_INSTANCE_ID);

        if (dialog == null && webViewDialog == null) {
            // Fallback: try to bring main activity to foreground
            try {
                Intent intent = new Intent(getContext(), getBridge().getActivity().getClass());
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                getContext().startActivity(intent);
                call.resolve();
            } catch (Exception e) {
                Log.e("InAppBrowser", "Error bringing main activity to foreground: " + e.getMessage());
                call.reject("WebView is not initialized and failed to restore main activity");
            }
            return;
        }

        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    try {
                        WebViewDialog targetDialog = (dialog != null) ? dialog : webViewDialog;
                        if (targetDialog != null) {
                            String currentUrl = "";
                            try {
                                currentUrl = targetDialog.getUrl();
                                if (currentUrl == null) {
                                    currentUrl = "";
                                }
                            } catch (Exception e) {
                                Log.e("InAppBrowser", "Error getting URL before close: " + e.getMessage());
                                currentUrl = "";
                            }

                            // Notify listeners about the close event.
                            // PR-4 chunk 7: tag with instance id.
                            notifyListeners(
                                "closeEvent",
                                new JSObject().put("url", currentUrl).put("id", instanceId)
                            );

                            targetDialog.dismiss();
                            WebViewRegistry.getShared().remove(instanceId);
                            if (isLegacyDefault) {
                                webViewDialog = null;
                            }
                            call.resolve();
                        } else {
                            // Secondary fallback inside UI thread
                            try {
                                Intent intent = new Intent(getContext(), getBridge().getActivity().getClass());
                                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                                getContext().startActivity(intent);
                                call.resolve();
                            } catch (Exception e) {
                                Log.e("InAppBrowser", "Error in secondary fallback: " + e.getMessage());
                                call.reject("WebView is not initialized");
                            }
                        }
                    } catch (Exception e) {
                        Log.e("InAppBrowser", "Error closing WebView: " + e.getMessage());
                        call.reject("Failed to close WebView: " + e.getMessage());
                    }
                }
            }
        );
    }

    private Bundle getHeaders(PluginCall pluginCall) {
        JSObject headersProvided = pluginCall.getObject("headers");
        Bundle headers = new Bundle();
        if (headersProvided != null) {
            Iterator<String> keys = headersProvided.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                headers.putString(key, headersProvided.getString(key));
            }
        }
        return headers;
    }

    protected void handleOnResume() {
        boolean ok = CustomTabsClient.bindCustomTabsService(getContext(), CUSTOM_TAB_PACKAGE_NAME, connection);
        if (!ok) {
            Log.e(getLogTag(), "Error binding to custom tabs service");
        }
    }

    protected void handleOnPause() {
        getContext().unbindService(connection);
    }

    public CustomTabsSession getCustomTabsSession() {
        if (customTabsClient == null) {
            return null;
        }

        if (currentSession == null) {
            currentSession = customTabsClient.newSession(
                new CustomTabsCallback() {
                    @Override
                    public void onNavigationEvent(int navigationEvent, Bundle extras) {
                        // Only fire browserPageLoaded for Custom Tabs, not for WebView
                        if (navigationEvent == NAVIGATION_FINISHED && webViewDialog == null) {
                            notifyListeners("browserPageLoaded", new JSObject());
                        }
                    }
                }
            );
        }
        return currentSession;
    }

    @Override
    protected void handleOnDestroy() {
        if (webViewDialog != null) {
            try {
                webViewDialog.dismiss();
            } catch (Exception e) {
                // Ignore, dialog may already be dismissed
            }
            webViewDialog = null;
        }
        currentPermissionRequest = null;
        customTabsClient = null;
        currentSession = null;
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getPluginVersion(final PluginCall call) {
        try {
            final JSObject ret = new JSObject();
            ret.put("version", this.pluginVersion);
            call.resolve(ret);
        } catch (final Exception e) {
            call.reject("Could not get plugin version", e);
        }
    }

    @PluginMethod
    public void updateDimensions(PluginCall call) {
        // Miden patch (PR-4 chunk 7): id-aware routing.
        final String instanceId = call.getString("id") != null
            ? call.getString("id")
            : WebViewRegistry.DEFAULT_INSTANCE_ID;
        final WebViewDialog target = WebViewRegistry.getShared().get(instanceId);
        if (target == null && webViewDialog == null) {
            call.reject("WebView is not initialized");
            return;
        }

        Integer width = call.getInt("width");
        Integer height = call.getInt("height");
        Integer x = call.getInt("x");
        Integer y = call.getInt("y");

        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    try {
                        WebViewDialog dialog = target != null ? target : webViewDialog;
                        if (dialog != null) {
                            dialog.updateDimensions(width, height, x, y);
                            call.resolve();
                        } else {
                            call.reject("WebView is not initialized");
                        }
                    } catch (Exception e) {
                        Log.e("InAppBrowser", "Error updating dimensions: " + e.getMessage());
                        call.reject("Failed to update dimensions: " + e.getMessage());
                    }
                }
            }
        );
    }

    /**
     * Miden patch: take a JPEG snapshot of the current webview content as a
     * base64 data URL. Used by the embedded dApp browser to show frozen
     * previews on minimized bubbles and card-switcher cards.
     *
     * PR-4 chunk 5: id-aware. Defaults to "default" so the legacy single-
     * instance call signature still works.
     */
    @PluginMethod
    public void snapshot(PluginCall call) {
        final String instanceId = call.getString("id") != null
            ? call.getString("id")
            : WebViewRegistry.DEFAULT_INSTANCE_ID;
        final WebViewDialog dialog = WebViewRegistry.getShared().get(instanceId);
        if (dialog == null) {
            call.reject("WebView is not initialized");
            return;
        }

        Float scaleArg = call.getFloat("scale");
        Float qualityArg = call.getFloat("quality");
        final float scale = (scaleArg != null) ? scaleArg : 0.5f;
        final float quality = (qualityArg != null) ? qualityArg : 0.7f;

        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    try {
                        String dataUrl = dialog.takeSnapshotData(scale, quality);
                        if (dataUrl == null) {
                            call.reject("snapshot failed");
                            return;
                        }
                        JSObject ret = new JSObject();
                        ret.put("data", dataUrl);
                        call.resolve(ret);
                    } catch (Exception e) {
                        Log.e("InAppBrowser", "Error taking snapshot: " + e.getMessage());
                        call.reject("snapshot failed: " + e.getMessage());
                    }
                }
            }
        );
    }

    /**
     * Miden plugin method (PR-4 chunk 5): toggle a specific instance's
     * visibility WITHOUT tearing down its WebView. The JS context, page
     * state, scroll position, and any in-flight network requests survive
     * across the hide/show cycle.
     *
     * Required params: id, visible.
     */
    @PluginMethod
    public void setVisible(PluginCall call) {
        final String instanceId = call.getString("id");
        if (instanceId == null) {
            call.reject("id required");
            return;
        }
        final boolean visible = Boolean.TRUE.equals(call.getBoolean("visible", true));
        final WebViewDialog dialog = WebViewRegistry.getShared().get(instanceId);
        if (dialog == null) {
            call.reject("instance not found: " + instanceId);
            return;
        }

        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    try {
                        if (visible) {
                            // Dialog.show() is the right primitive — it
                            // re-attaches the existing Window without
                            // recreating the WebView.
                            if (!dialog.isShowing()) {
                                dialog.show();
                            }
                        } else {
                            // Dialog.hide() detaches the Window from the
                            // screen but keeps the Dialog instance + its
                            // WebView alive in memory. State preservation
                            // works the same way as iOS UIWindow.isHidden.
                            if (dialog.isShowing()) {
                                dialog.hide();
                            }
                        }
                        call.resolve();
                    } catch (Exception e) {
                        Log.e("InAppBrowser", "setVisible failed: " + e.getMessage());
                        call.reject("setVisible failed: " + e.getMessage());
                    }
                }
            }
        );
    }

    /**
     * Miden plugin method (PR-4 chunk 5): list every currently registered
     * instance id. Used by the wallet's PR-6 cold-bubble restore logic and
     * the LRU eviction in PR-4 §memory-budget.
     */
    @PluginMethod
    public void listInstances(PluginCall call) {
        JSArray ids = new JSArray();
        for (String id : WebViewRegistry.getShared().allIds()) {
            ids.put(id);
        }
        JSObject ret = new JSObject();
        ret.put("ids", ids);
        call.resolve(ret);
    }

    /**
     * Miden plugin method (PR-4 chunk 5): close every registered instance.
     * Used on app shutdown / wallet reset. Each dialog is dismissed and the
     * registry is cleared. Individual closeEvent listeners are NOT fired —
     * callers know they're tearing everything down.
     */
    @PluginMethod
    public void closeAll(PluginCall call) {
        this.getActivity().runOnUiThread(
            new Runnable() {
                @Override
                public void run() {
                    for (java.util.Map.Entry<String, WebViewDialog> entry : WebViewRegistry.getShared().snapshot()) {
                        try {
                            entry.getValue().dismiss();
                        } catch (Exception e) {
                            Log.w("InAppBrowser", "closeAll: dismiss failed for " + entry.getKey() + ": " + e.getMessage());
                        }
                    }
                    WebViewRegistry.getShared().clear();
                    webViewDialog = null;
                    call.resolve();
                }
            }
        );
    }
}
