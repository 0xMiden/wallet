//! Secure storage module - platform-specific hardware security
//!
//! Provides hardware-backed key storage using:
//! - macOS: Secure Enclave (via Security.framework)
//! - Windows: TPM 2.0 (via NCrypt APIs)
//!
//! Linux is intentionally not supported - users should use the Chrome extension.

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

use crate::ipc_guard::ensure_wallet_webview;
use log::info;

// SECURITY: every command here is gated to the wallet's own webview. Without the
// guard (and the app ACL manifest that backs it) any page loaded in the dApp-browser
// window could invoke them: `delete_hardware_key` is a bare `SecItemDelete` with no
// biometric prompt, so a single line of site script would destroy the Secure Enclave
// key that wraps the vault key — on a Touch-ID-only wallet (no `vault_key_password`)
// that makes the mnemonic, every account auth key, the guardian cold key and the
// derived EVM keys unrecoverable. The encrypt/decrypt pair would likewise be a
// hardware oracle over attacker-supplied ciphertext.

/// Generate a hardware-backed key for encrypting the vault key
///
/// On macOS: Creates an EC P-256 key pair in the Secure Enclave
/// On Windows: Creates a key in the TPM
#[tauri::command]
pub fn generate_hardware_key(webview: tauri::Webview) -> Result<(), String> {
    ensure_wallet_webview(&webview)?;

    info!("generate_hardware_key called");

    #[cfg(target_os = "macos")]
    return macos::generate_hardware_key();

    #[cfg(target_os = "windows")]
    return windows::generate_hardware_key();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Hardware security not supported on this platform".to_string());
}

/// Encrypt data using the hardware-backed key
///
/// This will trigger biometric authentication (Touch ID, Windows Hello)
/// Returns base64-encoded encrypted data
#[tauri::command]
pub fn encrypt_with_hardware_key(webview: tauri::Webview, data: String) -> Result<String, String> {
    ensure_wallet_webview(&webview)?;

    info!("encrypt_with_hardware_key called");

    #[cfg(target_os = "macos")]
    return macos::encrypt_with_hardware_key(&data);

    #[cfg(target_os = "windows")]
    return windows::encrypt_with_hardware_key(&data);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Hardware security not supported on this platform".to_string());
}

/// Decrypt data using the hardware-backed key
///
/// This will trigger biometric authentication (Touch ID, Windows Hello)
/// Expects base64-encoded encrypted data, returns plaintext
#[tauri::command]
pub fn decrypt_with_hardware_key(webview: tauri::Webview, encrypted: String) -> Result<String, String> {
    ensure_wallet_webview(&webview)?;

    info!("decrypt_with_hardware_key called");

    #[cfg(target_os = "macos")]
    return macos::decrypt_with_hardware_key(&encrypted);

    #[cfg(target_os = "windows")]
    return windows::decrypt_with_hardware_key(&encrypted);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Hardware security not supported on this platform".to_string());
}

/// Delete the hardware-backed key
///
/// Used when resetting the wallet or disabling biometric unlock
#[tauri::command]
pub fn delete_hardware_key(webview: tauri::Webview) -> Result<(), String> {
    ensure_wallet_webview(&webview)?;

    info!("delete_hardware_key called");

    #[cfg(target_os = "macos")]
    return macos::delete_hardware_key();

    #[cfg(target_os = "windows")]
    return windows::delete_hardware_key();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Hardware security not supported on this platform".to_string());
}

/// Check if hardware security is available on this platform
///
/// Returns true on macOS (with Secure Enclave) and Windows (with TPM)
#[tauri::command]
pub fn is_hardware_security_available(webview: tauri::Webview) -> Result<bool, String> {
    ensure_wallet_webview(&webview)?;

    info!("is_hardware_security_available called");

    #[cfg(target_os = "macos")]
    return macos::is_hardware_security_available();

    #[cfg(target_os = "windows")]
    return windows::is_hardware_security_available();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Ok(false);
}

/// Check if a hardware key has been generated
#[tauri::command]
pub fn has_hardware_key(webview: tauri::Webview) -> Result<bool, String> {
    ensure_wallet_webview(&webview)?;

    info!("has_hardware_key called");

    #[cfg(target_os = "macos")]
    return macos::has_hardware_key();

    #[cfg(target_os = "windows")]
    return windows::has_hardware_key();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Ok(false);
}
