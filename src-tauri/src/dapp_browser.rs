//! dApp Browser module for opening external dApps in a separate window
//!
//! This module provides Tauri commands for:
//! - Opening a dApp in a new webview window with wallet API injection
//! - Navigation controls (back, forward, refresh)
//! - Closing the dApp window
//! - Handling wallet requests from dApps

use crate::ipc_guard::ensure_wallet_webview;
use log::info;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::webview::PageLoadEvent;

/// The initialization script injected into dApp pages
/// This includes the toolbar and wallet API
///
/// SECURITY: this script needs NO Tauri IPC. It reaches the wallet by navigating a
/// hidden iframe to `https://miden-wallet-request/<base64>`, which `on_navigation`
/// below intercepts; responses come back through `dapp_wallet_response` →
/// `webview.eval` from the wallet window.
///
/// That matters because the `dapp-browser` window loads arbitrary third-party pages
/// (`WebviewUrl::External`) and `tauri.conf.json` sets `withGlobalTauri: true`, so
/// `window.__TAURI__` exists on every page the user visits here. There used to be a
/// `capabilities/dapp-browser.json` with `"remote": { "urls": ["https://*", "http://*"] }`
/// granting `core:default`, `core:event:allow-emit/listen` and `core:window:allow-close`
/// to exactly those pages. Any visited site could then
/// `__TAURI__.event.emit('dapp-wallet-request', { request, origin: '<some other dApp>' })`
/// — the main window's listener takes the origin straight off the event payload, so the
/// forged origin matched a stored session and raised a genuine-looking approval — or
/// simply close the wallet window. That capability file has been deleted; without a
/// `remote` section a capability applies only to local (bundled) content, so do NOT
/// reintroduce one for this window. `src-tauri/permissions/app.toml` closes the same
/// hole for the app's OWN commands, which the deleted capability never covered, and
/// every one of them additionally refuses a non-`main` webview (`ipc_guard`).
const DAPP_INJECTION_SCRIPT: &str = include_str!("../scripts/dapp-injection.js");

/// Global the injected bridge reads its per-window token from, before deleting it.
const BRIDGE_TOKEN_GLOBAL: &str = "__MIDEN_BRIDGE_TOKEN__";

/// Default dApp browser window size (larger than main wallet for comfortable browsing)
const DAPP_WINDOW_WIDTH: f64 = 1200.0;
const DAPP_WINDOW_HEIGHT: f64 = 800.0;

/// Suffix of the dApp window's OS title, after the origin.
const DAPP_WINDOW_TITLE_SUFFIX: &str = "dApp Browser - Bread";

/// URL host used for dApp-to-wallet communication
const REQUEST_HOST: &str = "miden-wallet-request";

/// A per-window secret that authenticates a wallet request as coming from the
/// injected bridge running in the dApp window's MAIN FRAME.
///
/// `on_navigation` is wry's `webView:decidePolicyForNavigationAction:` delegate
/// (`wry-0.55.1/src/wkwebview/navigation.rs`), which fires for EVERY navigation
/// action and hands the handler only a URL — wry never consults
/// `action.targetFrame().isMainFrame()`, and the handler has no way to ask. So any
/// cross-origin sub-frame the top-level dApp embeds (an ad slot, a chat widget, a
/// compromised CDN script) could navigate itself to `https://miden-wallet-request/…`
/// and have the request attributed to the TOP-LEVEL origin below — inheriting that
/// dApp's approved session and its account, with the approval prompt naming the
/// innocent top-level site.
///
/// The token closes that. `WebviewBuilder::initialization_script` is
/// `for_main_frame_only: true` (tauri-2.11.0 `src/webview/mod.rs`), which WebKit
/// enforces on macOS/WKWebView and Linux/WebKitGTK, so there the token is never even
/// injected into a sub-frame. wry documents one exception — "Windows: scripts are
/// always added to subframes regardless of the `for_main_frame_only` option"
/// (wry-0.55.1 `src/lib.rs`) — so the injected bridge ALSO reads the token into a
/// closure and deletes the global before its own `window.top !== window.self`
/// bail-out, at document start, ahead of any page script. A sub-frame therefore
/// cannot observe the token on any platform, and the same-origin policy keeps it
/// from reading the parent's. It is 32 hex characters of CSPRNG output, fresh per
/// window, and never appears in any response.
fn new_bridge_token() -> String {
    let mut bytes = [0u8; 16];
    // A failure here would mean the OS RNG is unavailable; an empty token is then
    // rejected by `bridge_token_matches`, so the bridge fails CLOSED (no requests)
    // rather than open.
    if getrandom::fill(&mut bytes).is_err() {
        return String::new();
    }
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// The injection script with its per-window bridge token prepended.
///
/// The token is emitted as a JSON string literal, so nothing it could ever contain
/// escapes the assignment. The bridge copies it into a closure and deletes the
/// global on its first line, so the page's own scripts cannot read it back out and
/// hand it to a frame.
fn injection_script_with_token(token: &str) -> String {
    let literal = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
    format!("globalThis.{BRIDGE_TOKEN_GLOBAL} = {literal};\n{DAPP_INJECTION_SCRIPT}")
}

/// Whether a request carries this window's bridge token.
///
/// An absent token (a sub-frame's hand-built navigation), a wrong token, or an empty
/// expectation (RNG failure at window creation) all refuse.
fn bridge_token_matches(expected: &str, provided: Option<&str>) -> bool {
    !expected.is_empty() && provided == Some(expected)
}

/// Serialize a dApp page's URL into the origin the wallet keys sessions by.
///
/// MUST include the port. `MidenDAppSessions` is a map keyed by this exact string
/// (`getDApp`/`setDApp`/`removeDApp` in `lib/miden/back/dapp.ts`), and
/// `requestPermission` reconnects a matching origin with NO prompt at all — so a
/// coarser key silently shares one approved session, and its `PrivateDataPermission`,
/// with every other port on the same host. `http://localhost:5173` and
/// `http://localhost:8000` are distinct trust domains and must not collapse. The
/// other two platforms already key on a port-bearing origin (the extension uses the
/// browser-supplied `evt.origin`, mobile uses `new URL(url).origin`).
///
/// `Url::host_str()` drops the port, which is why this uses the URL crate's own
/// origin serialization instead of formatting scheme + host by hand.
///
/// Returns `None` for an OPAQUE origin (`file:`, `data:` and friends). Those have no
/// meaningful, comparable origin, so the request is refused rather than bucketed into
/// a single shared `scheme://unknown` session key.
fn dapp_request_origin(url_str: &str) -> Option<String> {
    let url = url::Url::parse(url_str).ok()?;
    match url.origin() {
        origin @ url::Origin::Tuple(..) => Some(origin.ascii_serialization()),
        url::Origin::Opaque(_) => None,
    }
}

/// The dApp window's OS title for a page at `url_str`.
///
/// SECURITY: this is the ONLY place the user is shown which site they are on, and
/// it is deliberately native. The injected toolbar (`scripts/dapp-injection.js`)
/// is ordinary DOM inside the dApp's own document and the injection script runs in
/// the page's main world, so anything it renders — including the `#miden-url`
/// address bar this replaces — is rewritable by one line of page script. The OS
/// title bar is outside the webview and the page cannot reach it.
///
/// Built from the same `dapp_request_origin` the wallet keys sessions by, so what
/// the user reads is exactly the principal a request from this window is
/// authorized against — not a prettier or coarser rendering that could disagree
/// (the port is part of the origin, and part of the title). An opaque origin has
/// no attributable site and its requests are refused anyway, so it shows the bare
/// suffix rather than an invented label.
fn dapp_window_title(url_str: &str) -> String {
    match dapp_request_origin(url_str) {
        Some(origin) => format!("{} — {}", origin, DAPP_WINDOW_TITLE_SUFFIX),
        None => DAPP_WINDOW_TITLE_SUFFIX.to_string(),
    }
}

/// Handle dApp request from intercepted navigation
///
/// `expected_token` is this window's bridge token (see `new_bridge_token`). A
/// request without it did not come from the injected bridge running in the
/// TOP-LEVEL document, so it is dropped BEFORE anything else — including the local
/// `CLOSE_WINDOW` command — rather than being attributed to the top-level origin an
/// embedded sub-frame happens to sit inside.
fn handle_dapp_request(app_handle: &AppHandle, request_json: &str, expected_token: &str) {
    // Parse the request
    let request: serde_json::Value = match serde_json::from_str(request_json) {
        Ok(v) => v,
        Err(_) => return,
    };

    if !bridge_token_matches(expected_token, request.get("token").and_then(|v| v.as_str())) {
        info!("Refusing dApp request: no valid bridge token (not from the top-level bridge)");
        return;
    }

    let payload = request.get("payload").cloned().unwrap_or(serde_json::json!(null));

    // Handle special commands locally
    if let Some(payload_type) = payload.get("type").and_then(|v| v.as_str()) {
        if payload_type == "CLOSE_WINDOW" {
            if let Some(window) = app_handle.get_webview_window("dapp-browser") {
                let _ = window.close();
            }
            return;
        }
    }

    // Get the origin from the dApp window. No usable origin (window gone, unparseable
    // URL, or an opaque `file:`/`data:` origin) → drop the request rather than attribute
    // it to a shared placeholder key that other pages would then inherit a session from.
    let origin = match app_handle
        .get_webview_window("dapp-browser")
        .and_then(|w| w.url().ok())
        .and_then(|url| dapp_request_origin(url.as_str()))
    {
        Some(origin) => origin,
        None => {
            info!("Refusing dApp request: no attributable origin for the dApp window");
            return;
        }
    };

    // Emit request to main window
    let app = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let main_window = match app.get_webview_window("main") {
            Some(w) => w,
            None => return,
        };

        // The token authenticates the bridge to Rust and stops here — it is never
        // echoed to the frontend, an event payload, or a response.
        let mut request = request;
        if let Some(object) = request.as_object_mut() {
            object.remove("token");
        }

        let emit_payload = serde_json::json!({
            "request": serde_json::to_string(&request).unwrap_or("{}".to_string()),
            "origin": origin
        });

        let _ = main_window.emit("dapp-wallet-request", emit_payload);
    });
}

/// Parse a URL the dApp window is allowed to load: `http`/`https` with a host.
///
/// The launcher's `normalizeUrl` (`DappLauncher/HeroSearch.tsx`) is a string-prefix
/// check, not a parse: it prepends `https://` unless the text already starts with
/// `http://` or `https://`, so any `http(s)://…` string — quotes, spaces and all —
/// arrives here verbatim, and every other entry point into `open_dapp_window`
/// (recent-dApp tiles, `lib/desktop/index.ts`) passes its URL through untouched.
/// Both branches validate through this BEFORE using the value, because the reuse
/// branch navigates by evaluating JS inside the CURRENTLY loaded dApp's document:
/// a `javascript:` URL assigned to `location.href` there runs under that dApp's
/// origin, with its live wallet session.
fn validate_dapp_url(url: &str) -> Result<url::Url, String> {
    let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Unsupported URL scheme: {}", parsed.scheme()));
    }
    if parsed.host_str().is_none() {
        return Err("URL has no host".to_string());
    }
    Ok(parsed)
}

/// The JS that points an ALREADY-OPEN dApp window at `url`.
///
/// The URL is emitted as a JSON string literal, never interpolated into a quoted
/// one. `format!("window.location.href = '{}';", url)` let a `'` inside the URL
/// close the literal so the rest of the string ran as statements — synchronously,
/// in the document the window still has loaded, i.e. under the previous dApp's
/// origin and its `window.midenWallet` bridge, before the navigation happened.
/// `serde_json` escapes quotes, backslashes and control characters, so the whole
/// URL stays inert inside one literal.
fn navigate_script(url: &url::Url) -> Result<String, String> {
    let literal = serde_json::to_string(url.as_str()).map_err(|e| e.to_string())?;
    Ok(format!("window.location.href = {};", literal))
}

/// Open a dApp in a new browser window
///
/// Creates a new Tauri webview window that loads the specified URL
/// with the wallet injection script for toolbar and wallet API
#[tauri::command]
pub async fn open_dapp_window(
    webview: tauri::Webview,
    url: String,
    app: AppHandle,
) -> Result<(), String> {
    ensure_wallet_webview(&webview)?;
    info!("Opening dApp window for URL: {}", url);

    // Validated before EITHER branch — the reuse branch below evaluates JS in the
    // currently loaded dApp's document, so it must never see an unvalidated string.
    let parsed_url = validate_dapp_url(&url)?;

    // Check if dApp window already exists
    if let Some(existing) = app.get_webview_window("dapp-browser") {
        // Focus existing window and navigate to new URL
        existing.set_focus().map_err(|e| e.to_string())?;
        existing
            .eval(&navigate_script(&parsed_url)?)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Get main window position to place dApp window nearby
    let main_window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    let position = main_window.outer_position().map_err(|e| e.to_string())?;

    // Clone app handle for use in navigation handler
    let app_for_nav = app.clone();

    // One token per window. Only the injected bridge running in the TOP-LEVEL
    // document ever keeps it (see `new_bridge_token`), and the navigation
    // interceptor requires it on every request it accepts.
    let bridge_token = new_bridge_token();
    let token_for_nav = bridge_token.clone();

    // Create the dApp browser window with larger size for comfortable browsing
    let dapp_window = WebviewWindowBuilder::new(
        &app,
        "dapp-browser",
        WebviewUrl::External(parsed_url.clone()),
    )
    .title(dapp_window_title(parsed_url.as_str()))
    .inner_size(DAPP_WINDOW_WIDTH, DAPP_WINDOW_HEIGHT)
    .position(
        position.x as f64 + 50.0,
        position.y as f64 + 50.0,
    )
    .initialization_script(injection_script_with_token(&bridge_token))
    // Re-title on every document the webview actually commits, so the title tracks
    // redirects and in-page navigations rather than only the URL we opened with.
    // `PageLoadEvent::Started` carries the URL of the load that began, which is the
    // same value `dapp_request_origin` will read off the window when that page
    // makes a wallet request.
    .on_page_load(|window, payload| {
        if matches!(payload.event(), PageLoadEvent::Started) {
            let _ = window.set_title(&dapp_window_title(payload.url().as_str()));
        }
    })
    .on_navigation(move |url| {
        let url_str = url.as_str();

        // Intercept miden-wallet-request URLs for dApp-to-wallet communication
        // Format: https://miden-wallet-request/{base64-encoded-payload}
        if let Ok(parsed) = url::Url::parse(url_str) {
            if parsed.host_str() == Some(REQUEST_HOST) {
                // Get the path (without leading slash) which contains the base64-encoded payload
                let path = parsed.path().trim_start_matches('/');
                if !path.is_empty() {
                    // Decode base64
                    if let Ok(decoded_bytes) = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        path
                    ) {
                        if let Ok(payload) = String::from_utf8(decoded_bytes) {
                            handle_dapp_request(&app_for_nav, &payload, &token_for_nav);
                        }
                    }
                }
                return false; // Prevent navigation
            }
        }
        true // Allow all other navigation
    })
    .resizable(true)
    .decorations(true)
    .visible(true)
    .build()
    .map_err(|e| e.to_string())?;

    // Focus the new window
    dapp_window.set_focus().map_err(|e| e.to_string())?;

    info!("dApp window created successfully ({}x{})", DAPP_WINDOW_WIDTH, DAPP_WINDOW_HEIGHT);
    Ok(())
}

/// Close the dApp browser window
#[tauri::command]
pub async fn close_dapp_window(webview: tauri::Webview, app: AppHandle) -> Result<(), String> {
    ensure_wallet_webview(&webview)?;
    if let Some(window) = app.get_webview_window("dapp-browser") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Navigate the dApp browser (back, forward, refresh)
#[tauri::command]
pub async fn dapp_navigate(
    webview: tauri::Webview,
    action: String,
    app: AppHandle,
) -> Result<(), String> {
    ensure_wallet_webview(&webview)?;
    if let Some(webview) = app.get_webview_window("dapp-browser") {
        match action.as_str() {
            "back" => {
                webview
                    .eval("history.back()")
                    .map_err(|e| e.to_string())?;
            }
            "forward" => {
                webview
                    .eval("history.forward()")
                    .map_err(|e| e.to_string())?;
            }
            "refresh" => {
                webview
                    .eval("location.reload()")
                    .map_err(|e| e.to_string())?;
            }
            _ => {
                return Err(format!("Unknown navigation action: {}", action));
            }
        }
    } else {
        return Err("dApp window not found".to_string());
    }

    Ok(())
}

/// Get the current URL of the dApp browser
#[tauri::command]
pub async fn dapp_get_url(webview: tauri::Webview, app: AppHandle) -> Result<String, String> {
    ensure_wallet_webview(&webview)?;
    if let Some(webview) = app.get_webview_window("dapp-browser") {
        webview
            .url()
            .map(|url| url.to_string())
            .map_err(|e| e.to_string())
    } else {
        Err("dApp window not found".to_string())
    }
}

/// Send a response back to the dApp window
///
/// Called from the main window to send wallet responses back to the dApp.
///
/// There is deliberately no command that lets the wallet run ARBITRARY script in the
/// dApp window. `show_dapp_confirmation_overlay` used to, and the desktop approval
/// prompt was built on it: the modal's DOM, its approve button and its
/// acknowledgement checkbox all lived in the requesting page's own JS realm, so a
/// `MutationObserver` in the page could tick the box and synthesise the click before
/// the user saw the dialog — self-approving connections and fund-moving
/// transactions. The prompt now renders in the wallet's own window
/// (`lib/desktop/DesktopDappConfirmationModal.tsx`), the way mobile always did.
#[tauri::command]
pub async fn dapp_wallet_response(
    webview: tauri::Webview,
    response: String,
    app: AppHandle,
) -> Result<(), String> {
    ensure_wallet_webview(&webview)?;
    if let Some(dapp_window) = app.get_webview_window("dapp-browser") {
        // Call the response handler in the dApp window
        // Note: response is already a JSON string, so we pass it directly without re-encoding
        let script = format!(
            r#"
            (function() {{
                if (window.__midenWalletResponse) {{
                    try {{
                        window.__midenWalletResponse({});
                    }} catch(e) {{
                        // Silent fail
                    }}
                }}
            }})();
            "#,
            response
        );
        dapp_window.eval(&script).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("dApp window not found".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        bridge_token_matches, dapp_request_origin, dapp_window_title, injection_script_with_token,
        navigate_script, new_bridge_token, validate_dapp_url, BRIDGE_TOKEN_GLOBAL,
        DAPP_INJECTION_SCRIPT,
    };

    #[test]
    fn a_request_without_this_windows_bridge_token_is_refused() {
        // `on_navigation` is wry's decidePolicyForNavigationAction delegate: it fires
        // for EVERY navigation action, including one a cross-origin sub-frame performs
        // on itself, and hands the handler only a URL. Without the token an embedded
        // ad/chat/CDN frame could navigate to `https://miden-wallet-request/<payload>`
        // and have the request stamped with the TOP-LEVEL dApp's origin — inheriting
        // that site's approved session and account.
        let expected = "0123456789abcdef0123456789abcdef";
        assert!(bridge_token_matches(expected, Some(expected)));
        // No token at all: the shape a hand-built sub-frame navigation has.
        assert!(!bridge_token_matches(expected, None));
        assert!(!bridge_token_matches(expected, Some("")));
        assert!(!bridge_token_matches(expected, Some("guessed")));
        // Not a prefix match, and not truncatable.
        assert!(!bridge_token_matches(expected, Some(&expected[..16])));
    }

    #[test]
    fn an_empty_expectation_fails_closed() {
        // `new_bridge_token` returns "" only if the OS RNG failed. Every request must
        // then be refused rather than every request being accepted.
        assert!(!bridge_token_matches("", None));
        assert!(!bridge_token_matches("", Some("")));
        assert!(!bridge_token_matches("", Some("anything")));
    }

    #[test]
    fn each_window_gets_its_own_unguessable_token() {
        let a = new_bridge_token();
        let b = new_bridge_token();
        assert_eq!(a.len(), 32, "16 CSPRNG bytes as hex");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn the_token_reaches_the_bridge_as_one_json_literal() {
        let script = injection_script_with_token("0123456789abcdef0123456789abcdef");
        assert!(script.starts_with(&format!(
            "globalThis.{BRIDGE_TOKEN_GLOBAL} = \"0123456789abcdef0123456789abcdef\";"
        )));
        // The bridge still follows the assignment.
        assert!(script.contains(DAPP_INJECTION_SCRIPT));
        // And the bridge actually reads it and sends it.
        assert!(DAPP_INJECTION_SCRIPT.contains(BRIDGE_TOKEN_GLOBAL));
        assert!(DAPP_INJECTION_SCRIPT.contains("token: BRIDGE_TOKEN"));
    }

    #[test]
    fn the_bridge_denies_sub_frames_even_where_the_script_reaches_them() {
        // wry: "Windows: scripts are always added to subframes regardless of the
        // `for_main_frame_only` option". So on WebView2 this script DOES run in a
        // sub-frame and has to refuse itself: it must consume and delete the token
        // BEFORE the frame check (so no page script in any frame can read it), then
        // bail out of everything else unless it is the top-level document.
        let consume = DAPP_INJECTION_SCRIPT
            .find(&format!("delete globalThis.{BRIDGE_TOKEN_GLOBAL}"))
            .expect("the bridge removes the token global");
        let frame_check = DAPP_INJECTION_SCRIPT
            .find("if (window.top !== window.self) return;")
            .expect("the bridge runs only in the top-level document");
        assert!(
            consume < frame_check,
            "a sub-frame must be denied the token before it is denied the bridge"
        );
        // The wallet API is defined after the bail-out, so a sub-frame never gets one.
        let wallet_api = DAPP_INJECTION_SCRIPT
            .find("function injectWalletAPI()")
            .expect("the bridge defines the wallet API");
        assert!(frame_check < wallet_api);
    }

    #[test]
    fn no_command_evals_an_approval_prompt_into_the_dapps_own_document() {
        // The desktop approval prompt used to be `eval`ed into the requesting page's
        // main world, so the page owned the modal's DOM: a MutationObserver could tick
        // the standing-private-data box and synthesise the approve click before the
        // user saw it, self-approving connects and fund-moving sends. The verdict then
        // travelled back over an unauthenticated navigation the page could perform
        // itself. Both are gone — the prompt renders in the wallet's own window, the
        // way mobile always did. Asserted against the handler list, because only a
        // REGISTERED command is reachable from a webview.
        let registered_commands = include_str!("lib.rs");
        assert!(!registered_commands.contains("show_dapp_confirmation_overlay"));
        // Nor is there still a dApp-window command whose origin would be read off the
        // top-level page (`dapp_wallet_request`); the bridge is the token-checked
        // navigation intercept only.
        assert!(!registered_commands.contains("dapp_wallet_request"));
        // The injected bridge no longer has a channel for returning a verdict.
        assert!(!DAPP_INJECTION_SCRIPT.contains("confirmation-response"));
    }

    #[test]
    fn the_injected_toolbar_displays_no_address() {
        // The injection script runs in the page's main world, so any address it
        // renders is page-owned: one line of site script rewrites it (and a
        // MutationObserver re-applies it after any repaint), making the wallet's own
        // chrome read `app.uniswap.org` on an attacker's page. Navigation actions may
        // live in the page; the address may not.
        assert!(!DAPP_INJECTION_SCRIPT.contains("id=\"miden-url\""));
        assert!(!DAPP_INJECTION_SCRIPT.contains("${window.location.hostname}"));
        // The actions it DOES carry are still there.
        assert!(DAPP_INJECTION_SCRIPT.contains("id=\"miden-back\""));
        assert!(DAPP_INJECTION_SCRIPT.contains("id=\"miden-close\""));
    }

    #[test]
    fn the_window_title_carries_the_wallet_computed_origin() {
        // Same string the wallet keys sessions by — including the port, so
        // `localhost:5173` and `localhost:8000` read differently in the title too.
        assert_eq!(
            dapp_window_title("https://example.com/app?x=1#y"),
            "https://example.com — dApp Browser - Bread"
        );
        assert_eq!(
            dapp_window_title("http://localhost:5173/"),
            "http://localhost:5173 — dApp Browser - Bread"
        );
        assert_ne!(
            dapp_window_title("http://localhost:5173/"),
            dapp_window_title("http://localhost:8000/")
        );
    }

    #[test]
    fn an_opaque_origin_gets_no_invented_label() {
        // No attributable origin → the request is refused anyway, so the title must
        // not name a site.
        assert_eq!(dapp_window_title("data:text/html,<h1>hi</h1>"), "dApp Browser - Bread");
        assert_eq!(dapp_window_title("not a url"), "dApp Browser - Bread");
    }

    #[test]
    fn refuses_a_scheme_the_dapp_window_must_never_load() {
        // `javascript:` is the dangerous one: the reuse branch assigns the URL to
        // `location.href` of the dApp page that is still loaded, which executes it
        // in that document under that origin's approved wallet session.
        assert!(validate_dapp_url("javascript:fetch('https://attacker')").is_err());
        // With an authority the parse yields a host, so ONLY the scheme check
        // stops it; browsers still run the payload after the `//…%0a` comment.
        assert!(
            validate_dapp_url("javascript://example.com/%0afetch('https://attacker')").is_err()
        );
        assert!(validate_dapp_url("file:///Users/me/evil.html").is_err());
        assert!(validate_dapp_url("data:text/html,<h1>hi</h1>").is_err());
        assert!(validate_dapp_url("not a url").is_err());
        assert!(validate_dapp_url("https://example.com/app").is_ok());
        assert!(validate_dapp_url("http://localhost:5173/").is_ok());
    }

    #[test]
    fn keeps_a_quote_bearing_url_inside_one_string_literal() {
        // The launcher's `normalizeUrl` passes this through unchanged (it only
        // prepends `https://` to text that does not already start with
        // `http://`/`https://`), and a single quote is not percent-encoded in a
        // URL path — so the escaping, not the parse, is what keeps the trailing
        // statements from running.
        let injected = "https://x/';window.midenWallet.getPrivateNotes();//";
        let url =
            validate_dapp_url(injected).expect("an https URL with a quoted path still parses");

        let script = navigate_script(&url).expect("a URL serializes as a JSON string");

        // Exactly one double-quoted literal, ending the statement: nothing the URL
        // carries can escape it. A single-quote-delimited `format!` has none.
        assert!(script.starts_with("window.location.href = \""));
        assert!(script.ends_with("\";"));
        assert_eq!(script.matches('"').count(), 2);
        // The payload is still there — inert, as data inside the literal.
        assert!(script.contains("';window.midenWallet.getPrivateNotes();//"));
    }

    #[test]
    fn emits_an_ordinary_url_as_a_json_string_literal() {
        let url = validate_dapp_url("https://example.com/app?x=1#y").expect("valid https URL");
        let script = navigate_script(&url).expect("a URL serializes as a JSON string");
        assert_eq!(
            script,
            "window.location.href = \"https://example.com/app?x=1#y\";"
        );
    }

    #[test]
    fn keeps_a_non_default_port_so_sessions_do_not_collapse() {
        assert_eq!(
            dapp_request_origin("http://localhost:5173/app?x=1#y"),
            Some("http://localhost:5173".to_string())
        );
        assert_ne!(
            dapp_request_origin("http://localhost:5173/"),
            dapp_request_origin("http://localhost:8000/")
        );
        assert_ne!(
            dapp_request_origin("https://example.com/"),
            dapp_request_origin("https://example.com:8443/")
        );
    }

    #[test]
    fn omits_the_default_port_so_the_key_matches_the_other_platforms() {
        // `new URL('https://example.com:443/').origin` is 'https://example.com',
        // and the browser-supplied `evt.origin` behaves the same way.
        assert_eq!(
            dapp_request_origin("https://example.com:443/"),
            Some("https://example.com".to_string())
        );
        assert_eq!(
            dapp_request_origin("http://example.com:80/"),
            Some("http://example.com".to_string())
        );
    }

    #[test]
    fn refuses_opaque_and_unparseable_origins() {
        assert_eq!(dapp_request_origin("file:///Users/me/evil.html"), None);
        assert_eq!(dapp_request_origin("data:text/html,<h1>hi</h1>"), None);
        assert_eq!(dapp_request_origin("not a url"), None);
    }
}
