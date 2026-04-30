import Foundation
import Capacitor
import AuthenticationServices
import CryptoKit
import os.log

private let logger = OSLog(subsystem: "com.miden.wallet", category: "Passkey")

/// Native Capacitor plugin for passkey operations using Apple's ASAuthorization API
/// with PRF (Pseudo-Random Function) extension support.
///
/// WKWebView's JavaScript WebAuthn bridge does not pass through the PRF extension,
/// so we bypass it entirely and call the native API directly.
///
/// Requires iOS 18.0+ for PRF support.
@objc(PasskeyPlugin)
public class PasskeyPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "PasskeyPlugin"
    public let jsName = "Passkey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise)
    ]

    // Strong reference to prevent ASAuthorizationController deallocation mid-flow
    private var authController: ASAuthorizationController?
    private var currentCall: CAPPluginCall?
    private var isRegistration = false

    // MARK: - ASAuthorizationControllerPresentationContextProviding

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return self.bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    // MARK: - Plugin Methods

    @objc func isAvailable(_ call: CAPPluginCall) {
        os_log("[Passkey] isAvailable called", log: logger, type: .debug)
        if #available(iOS 18.0, *) {
            call.resolve(["available": true])
        } else {
            os_log("[Passkey] iOS 18.0+ required for PRF support", log: logger, type: .info)
            call.resolve(["available": false])
        }
    }

    @objc func register(_ call: CAPPluginCall) {
        os_log("[Passkey] register called", log: logger, type: .debug)

        guard #available(iOS 18.0, *) else {
            call.reject("Passkey PRF requires iOS 18.0+")
            return
        }

        guard let rpId = call.getString("rpId"),
              let userName = call.getString("userName"),
              let _ = call.getString("userDisplayName"),
              let userIdBase64 = call.getString("userId"),
              let challengeBase64 = call.getString("challenge"),
              let prfSaltBase64 = call.getString("prfSalt") else {
            call.reject("Missing required parameters")
            return
        }

        guard let userId = Data(base64Encoded: userIdBase64),
              let challenge = Data(base64Encoded: challengeBase64),
              let prfSalt = Data(base64Encoded: prfSaltBase64) else {
            call.reject("Invalid base64 encoding")
            return
        }

        self.currentCall = call
        self.isRegistration = true

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge,
            name: userName,
            userID: userId
        )

        // Attach PRF with salt so registration returns the PRF output directly.
        let saltValues = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: prfSalt)
        request.prf = .inputValues(saltValues)

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.authController = controller
            controller.performRequests()
        }
    }

    @objc func authenticate(_ call: CAPPluginCall) {
        os_log("[Passkey] authenticate called", log: logger, type: .debug)

        guard #available(iOS 18.0, *) else {
            call.reject("Passkey PRF requires iOS 18.0+")
            return
        }

        guard let rpId = call.getString("rpId"),
              let credentialIdBase64 = call.getString("credentialId"),
              let challengeBase64 = call.getString("challenge"),
              let prfSaltBase64 = call.getString("prfSalt") else {
            call.reject("Missing required parameters")
            return
        }

        guard let credentialId = Data(base64Encoded: credentialIdBase64),
              let challenge = Data(base64Encoded: challengeBase64),
              let prfSalt = Data(base64Encoded: prfSaltBase64) else {
            call.reject("Invalid base64 encoding")
            return
        }

        self.currentCall = call
        self.isRegistration = false

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)

        request.allowedCredentials = [
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credentialId)
        ]

        let saltValues = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: prfSalt)
        request.prf = .inputValues(saltValues)

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.authController = controller
            controller.performRequests()
        }
    }

    // MARK: - ASAuthorizationControllerDelegate

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        os_log("[Passkey] Authorization completed", log: logger, type: .debug)

        guard let call = currentCall else {
            os_log("[Passkey] No pending call", log: logger, type: .error)
            return
        }

        if #available(iOS 18.0, *) {
            if let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
                handleRegistrationResult(registration, call: call)
            } else if let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
                handleAssertionResult(assertion, call: call)
            } else {
                call.reject("Unexpected credential type")
                cleanup()
            }
        } else {
            call.reject("iOS 18.0+ required")
            cleanup()
        }
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        os_log("[Passkey] Authorization error: %{public}@", log: logger, type: .error, error.localizedDescription)

        guard let call = currentCall else { return }

        let nsError = error as NSError
        if nsError.domain == ASAuthorizationError.errorDomain,
           let code = ASAuthorizationError.Code(rawValue: nsError.code) {
            switch code {
            case .canceled:
                call.reject("Passkey operation was cancelled", "CANCELLED")
            case .failed:
                call.reject("Passkey operation failed", "FAILED")
            case .invalidResponse:
                call.reject("Invalid response from authenticator", "INVALID_RESPONSE")
            case .notHandled:
                call.reject("Request not handled", "NOT_HANDLED")
            case .notInteractive:
                call.reject("Not interactive", "NOT_INTERACTIVE")
            @unknown default:
                call.reject("Authorization error: \(error.localizedDescription)")
            }
        } else {
            call.reject("Passkey error: \(error.localizedDescription)")
        }

        cleanup()
    }

    // MARK: - Result Handlers

    @available(iOS 18.0, *)
    private func handleRegistrationResult(
        _ registration: ASAuthorizationPlatformPublicKeyCredentialRegistration,
        call: CAPPluginCall
    ) {
        let credentialId = registration.credentialID
        os_log("[Passkey] Registration succeeded, credentialId length: %d", log: logger, type: .debug, credentialId.count)

        guard let prfOutput = registration.prf else {
            os_log("[Passkey] No PRF output from registration", log: logger, type: .error)
            call.reject("PRF extension not supported by this authenticator")
            cleanup()
            return
        }

        guard prfOutput.isSupported else {
            os_log("[Passkey] PRF not supported by authenticator", log: logger, type: .error)
            call.reject("PRF extension not supported by this authenticator")
            cleanup()
            return
        }

        guard let prfKey = prfOutput.first else {
            os_log("[Passkey] PRF output has no first key", log: logger, type: .error)
            call.reject("PRF output not available from registration")
            cleanup()
            return
        }

        let prfData = prfKey.withUnsafeBytes { Data(Array($0)) }
        os_log("[Passkey] PRF output obtained from registration, length: %d", log: logger, type: .debug, prfData.count)

        call.resolve([
            "credentialId": credentialId.base64EncodedString(),
            "prfOutput": prfData.base64EncodedString()
        ])

        cleanup()
    }

    @available(iOS 18.0, *)
    private func handleAssertionResult(
        _ assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion,
        call: CAPPluginCall
    ) {
        os_log("[Passkey] Assertion completed", log: logger, type: .debug)

        guard let prfResult = assertion.prf else {
            os_log("[Passkey] No PRF output in assertion result", log: logger, type: .error)
            call.reject("PRF output not available")
            cleanup()
            return
        }

        let prfData = prfResult.first.withUnsafeBytes { Data(Array($0)) }
        os_log("[Passkey] PRF output obtained, length: %d", log: logger, type: .debug, prfData.count)

        call.resolve([
            "credentialId": assertion.credentialID.base64EncodedString(),
            "prfOutput": prfData.base64EncodedString()
        ])

        cleanup()
    }

    // MARK: - Cleanup

    private func cleanup() {
        currentCall = nil
        authController = nil
        isRegistration = false
    }
}
