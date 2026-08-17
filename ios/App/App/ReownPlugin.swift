//
//  ReownPlugin.swift
//  App
//
//  Created by Utkarsh Sharma on 06/06/26.
//

import Foundation
import UIKit
import Combine
import Capacitor
import CryptoSwift
import Security
import ReownAppKit
import WalletConnectNetworking
import WalletConnectRelay
import WalletConnectSign
import WalletConnectSigner

private final class ReownWebSocket: NSObject, WebSocketConnecting, URLSessionWebSocketDelegate {
    var isConnected: Bool {
        connected
    }
    var onConnect: (() -> Void)?
    var onDisconnect: ((Error?) -> Void)?
    var onText: ((String) -> Void)?
    var request: URLRequest

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var connected = false

    init(url: URL) {
        self.request = URLRequest(url: url)
        super.init()
    }

    func connect() {
        disconnect()
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        self.session = session
        self.task = task
        task.resume()
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        if connected {
            connected = false
            onDisconnect?(nil)
        }
    }

    func write(string: String, completion: (() -> Void)?) {
        task?.send(.string(string)) { [weak self] error in
            if let error {
                self?.connected = false
                self?.onDisconnect?(error)
                return
            }
            completion?()
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        connected = true
        onConnect?()
        receiveNext()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        connected = false
        onDisconnect?(nil)
    }

    private func receiveNext() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.string(let string)):
                self.onText?(string)
                self.receiveNext()
            case .success(.data(let data)):
                if let string = String(data: data, encoding: .utf8) {
                    self.onText?(string)
                }
                self.receiveNext()
            case .failure(let error):
                self.connected = false
                self.onDisconnect?(error)
            @unknown default:
                self.receiveNext()
            }
        }
    }
}

private struct ReownSocketFactory: WebSocketFactory {
    func create(with url: URL) -> WebSocketConnecting {
        ReownWebSocket(url: url)
    }
}

// Reown persists its relay client-id in a keychain access group named by
// `groupIdentifier`. It MUST be a group this app is entitled to — otherwise the
// keychain ops fail with errSecMissingEntitlement, which reown-swift force-tries
// (`try!` in AppPairService.create) → EXC_BREAKPOINT the moment a pairing is
// created. The entitled group is `<AppIdentifierPrefix><bundleId>`, and the
// prefix is the signing team's ID — which differs between release and dev-team
// builds — so resolve it at runtime via the bundle-seed keychain probe instead
// of hardcoding. Simulators don't enforce access groups, so a bad group only
// crashes on physical devices.
private func resolvedReownKeychainGroup() -> String {
    let bundleId = Bundle.main.bundleIdentifier ?? "com.miden.bread"
    let fallback = "LHU7B7J5WL.\(bundleId)"

    let probe: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "reown-keychain-group-probe",
        kSecAttrAccount as String: "probe",
        kSecReturnAttributes as String: true
    ]

    var result: CFTypeRef?
    var status = SecItemAdd(probe as CFDictionary, &result)
    if status == errSecDuplicateItem {
        status = SecItemCopyMatching(probe as CFDictionary, &result)
    }

    guard status == errSecSuccess,
          let attributes = result as? [String: Any],
          let accessGroup = attributes[kSecAttrAccessGroup as String] as? String,
          let teamPrefix = accessGroup.split(separator: ".").first else {
        return fallback
    }
    return "\(teamPrefix).\(bundleId)"
}

private enum ReownCryptoError: Error {
    case publicKeyRecoveryUnsupported
}

private struct ReownCryptoProvider: CryptoProvider {
    func recoverPubKey(signature: EthereumSignature, message: Data) throws -> Data {
        throw ReownCryptoError.publicKeyRecoveryUnsupported
    }

    func keccak256(_ data: Data) -> Data {
        let digest = SHA3(variant: .keccak256)
        let hash = digest.calculate(for: [UInt8](data))
        return Data(hash)
    }
}

private struct PendingReownRequest {
    let call: CAPPluginCall
    let request: Request
    let resolvesHash: Bool
}

private struct NativeEthereumTransaction: Codable {
    let from: String?
    let to: String
    let value: String?
    let data: String?
    let gas: String?
    let gasPrice: String?
    let maxFeePerGas: String?
    let maxPriorityFeePerGas: String?

    enum CodingKeys: String, CodingKey {
        case from
        case to
        case value
        case data
        case gas
        case gasPrice
        case maxFeePerGas
        case maxPriorityFeePerGas
    }
}

@objc(ReownPlugin)
public class ReownPlugin: CAPPlugin, CAPBridgedPlugin {
    private static var appKitConfigured = false
    private static var pendingDeepLinks: [URL] = []

    public let identifier = "ReownPlugin"
    public let jsName = "Reown"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connectUri", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSessions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectChain", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "launchWallet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanup", returnType: CAPPluginReturnPromise)
    ]

    private var configured = false
    private var subscriptions = Set<AnyCancellable>()
    private var pendingRequests: [PendingReownRequest] = []
    private var socketStatus: String?
    // Proposal namespaces built in configure(); reused by connectUri() (E2E) to
    // create a pairing directly and hand the wc: URI to JS, bypassing the modal.
    private var proposalNamespaces: [String: ProposalNamespace] = [:]

    public static func handleDeeplink(_ url: URL) {
        guard appKitConfigured else {
            pendingDeepLinks.append(url)
            return
        }
        AppKit.instance.handleDeeplink(url)
    }

    @objc func configure(_ call: CAPPluginCall) {
        guard let projectId = call.getString("projectId"), !projectId.isEmpty else {
            call.reject("Missing WalletConnect projectId")
            return
        }

        if ReownPlugin.appKitConfigured {
            configured = true
            subscribeIfNeeded()
            notifyStateChanged()
            call.resolve()
            return
        }

        let appName = call.getString("appName") ?? "Bread Wallet"
        let appDescription = call.getString("appDescription") ?? "Bread wallet"
        let appUrl = call.getString("appUrl") ?? "https://miden.io"
        let icons = call.getArray("icons", String.self) ?? []
        let nativeRedirect = call.getString("nativeRedirect")
        let universalRedirect = call.getString("universalRedirect")
        let linkMode = call.getBool("linkMode") ?? false
        let chainIds = call.getArray("chainIds", Int.self) ?? [11155111]
        let methods = Set(call.getArray("methods", String.self) ?? ["eth_sendTransaction", "personal_sign", "eth_signTypedData"])
        let events = Set(call.getArray("events", String.self) ?? ["chainChanged", "accountsChanged"])
        let blockchains = chainIds.compactMap { Blockchain("eip155:\($0)") }

        guard !blockchains.isEmpty else {
            call.reject("No valid EVM chains configured")
            return
        }

        let redirect: AppMetadata.Redirect
        do {
            redirect = try AppMetadata.Redirect(
                native: nativeRedirect ?? "com.miden.wallet://",
                universal: universalRedirect,
                linkMode: universalRedirect != nil && linkMode
            )
        } catch {
            call.reject("Invalid WalletConnect redirect metadata: \(error.localizedDescription)")
            return
        }

        let metadata = AppMetadata(
            name: appName,
            description: appDescription,
            url: appUrl,
            icons: icons,
            redirect: redirect
        )

        let namespaces: [String: ProposalNamespace] = [
            "eip155": ProposalNamespace(
                chains: blockchains,
                methods: methods,
                events: events
            )
        ]
        self.proposalNamespaces = namespaces

        Networking.configure(
            groupIdentifier: resolvedReownKeychainGroup(),
            projectId: projectId,
            socketFactory: ReownSocketFactory()
        )

        AppKit.configure(
            projectId: projectId,
            metadata: metadata,
            crypto: ReownCryptoProvider(),
            authRequestParams: nil
        ) { error in
            print("[ReownPlugin] AppKit configure error: \(error)")
        }
        AppKit.set(sessionParams: SessionParams(namespaces: namespaces, sessionProperties: nil))

        configured = true
        ReownPlugin.appKitConfigured = true
        subscribeIfNeeded()
        ReownPlugin.pendingDeepLinks.forEach { AppKit.instance.handleDeeplink($0) }
        ReownPlugin.pendingDeepLinks.removeAll()
        notifyStateChanged()
        call.resolve()
    }

    @objc func present(_ call: CAPPluginCall) {
        guardConfigured(call) {
            DispatchQueue.main.async {
                AppKit.present(from: nil)
                call.resolve()
            }
        }
    }

    /// E2E-only: create a WalletConnect pairing directly (bypassing the AppKit QR
    /// modal) and hand the `wc:` URI to JS, so a headless counterparty can pair.
    /// Call this INSTEAD of present() (calling both would create two pairings).
    /// Session settlement afterward flows through the existing sessionSettle
    /// publisher → stateChanged, so no extra wiring is needed.
    @objc func connectUri(_ call: CAPPluginCall) {
        guardConfigured(call) {
            let namespaces = self.proposalNamespaces
            guard !namespaces.isEmpty else {
                call.reject("connectUri: no proposal namespaces (configure not completed)")
                return
            }
            Task {
                do {
                    let uri = try await Sign.instance.connect(namespaces: namespaces)
                    await MainActor.run {
                        self.notifyListeners("displayUri", data: ["uri": uri.absoluteString])
                        call.resolve(["uri": uri.absoluteString])
                    }
                } catch {
                    await MainActor.run { call.reject(error.localizedDescription) }
                }
            }
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(currentState())
    }

    @objc func getSessions(_ call: CAPPluginCall) {
        call.resolve([
            "sessions": sessionPayloads()
        ])
    }

    @objc func selectChain(_ call: CAPPluginCall) {
        guard call.getInt("chainId") != nil else {
            call.reject("Missing or invalid chainId")
            return
        }

        notifyStateChanged()
        call.resolve()
    }

    @objc func request(_ call: CAPPluginCall) {
        guardConfigured(call) {
            guard let method = call.getString("method"),
                  let chainId = call.getInt("chainId"),
                  let blockchain = Blockchain("eip155:\(chainId)") else {
                call.reject("Missing method or chainId")
                return
            }

            guard let session = self.session(for: call.getString("topic")) else {
                call.reject("No WalletConnect session is connected")
                return
            }

            guard let params = call.getValue("params") else {
                call.reject("Missing params")
                return
            }

            self.publishRequest(
                call: call,
                session: session,
                method: method,
                params: AnyCodable(any: params),
                chainId: blockchain,
                resolvesHash: false
            )
        }
    }

    @objc func sendTransaction(_ call: CAPPluginCall) {
        guardConfigured(call) {
            guard let chainId = call.getInt("chainId"),
                  let blockchain = Blockchain("eip155:\(chainId)") else {
                call.reject("Missing or invalid chainId")
                return
            }

            guard let to = call.getString("to") else {
                call.reject("Missing transaction recipient")
                return
            }

            guard let session = self.session(for: nil) else {
                call.reject("No WalletConnect session is connected")
                return
            }

            let tx = NativeEthereumTransaction(
                from: call.getString("from") ?? self.firstAddress(in: session),
                to: to,
                value: call.getString("value"),
                data: call.getString("data"),
                gas: call.getString("gas"),
                gasPrice: call.getString("gasPrice"),
                maxFeePerGas: call.getString("maxFeePerGas"),
                maxPriorityFeePerGas: call.getString("maxPriorityFeePerGas")
            )

            self.publishRequest(
                call: call,
                session: session,
                method: "eth_sendTransaction",
                params: AnyCodable([tx]),
                chainId: blockchain,
                resolvesHash: true
            )
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guardConfigured(call) {
            let topic = call.getString("topic") ?? self.session(for: nil)?.topic
            guard let topic else {
                call.resolve()
                return
            }

            Task {
                do {
                    try await Sign.instance.disconnect(topic: topic)
                    await MainActor.run {
                        self.notifyStateChanged()
                        call.resolve()
                    }
                } catch {
                    await MainActor.run {
                        call.reject(error.localizedDescription)
                    }
                }
            }
        }
    }

    @objc func launchWallet(_ call: CAPPluginCall) {
        guardConfigured(call) {
            AppKit.instance.launchCurrentWallet()
            call.resolve()
        }
    }

    @objc func cleanup(_ call: CAPPluginCall) {
        guardConfigured(call) {
            Task {
                do {
                    try await AppKit.instance.cleanup()
                    await MainActor.run {
                        self.notifyStateChanged()
                        call.resolve()
                    }
                } catch {
                    await MainActor.run {
                        call.reject(error.localizedDescription)
                    }
                }
            }
        }
    }
}

private extension ReownPlugin {
    var isConfigured: Bool {
        configured || ReownPlugin.appKitConfigured
    }

    var disconnectedState: JSObject {
        [
            "configured": isConfigured,
            "connected": false,
            "accounts": []
        ]
    }

    func guardConfigured(_ call: CAPPluginCall, run: () -> Void) {
        guard isConfigured else {
            call.reject("Native Reown is not configured")
            return
        }
        run()
    }

    func subscribeIfNeeded() {
        guard subscriptions.isEmpty else { return }

        Sign.instance.sessionSettlePublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _, _ in
                self?.notifyStateChanged()
            }
            .store(in: &subscriptions)

        Sign.instance.sessionDeletePublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.notifyStateChanged()
            }
            .store(in: &subscriptions)

        Sign.instance.sessionResponsePublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] response in
                self?.handle(response: response)
            }
            .store(in: &subscriptions)

        AppKit.instance.socketConnectionStatusPublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                guard let self else { return }
                self.socketStatus = String(describing: status)
                self.notifyListeners("socketStatus", data: ["status": self.socketStatus ?? "unknown"])
                self.notifyStateChanged()
            }
            .store(in: &subscriptions)
    }

    func publishRequest(
        call: CAPPluginCall,
        session: Session,
        method: String,
        params: AnyCodable,
        chainId: Blockchain,
        resolvesHash: Bool
    ) {
        let request: Request
        do {
            request = try Request(
                topic: session.topic,
                method: method,
                params: params,
                chainId: chainId,
                ttl: 300
            )
        } catch {
            call.reject(error.localizedDescription)
            return
        }

        Task {
            do {
                try await Sign.instance.request(params: request)
                await MainActor.run {
                    self.pendingRequests.append(PendingReownRequest(call: call, request: request, resolvesHash: resolvesHash))
                    self.openWallet(for: request)
                }
            } catch {
                await MainActor.run {
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    func handle(response: Response) {
        notifyListeners("sessionResponse", data: [
            "result": String(describing: response.result)
        ])

        guard !pendingRequests.isEmpty else {
            return
        }

        let pending = pendingRequests.removeFirst()

        switch response.result {
        case .response(let result):
            let value = result.stringRepresentation
            if pending.resolvesHash {
                pending.call.resolve(["hash": value])
            } else {
                pending.call.resolve(["result": value])
            }
        case .error(let error):
            pending.call.reject(error.message)
        }
    }

    func openWallet(for request: Request) {
        guard let session = session(for: request.topic) else {
            return
        }

        let redirectUrl = session.peer.redirect?.native ?? session.peer.redirect?.universal
        guard var plainAppUrl = redirectUrl else {
            return
        }

        if plainAppUrl.hasPrefix("http://") || plainAppUrl.hasPrefix("https://") {
            if plainAppUrl.hasSuffix("/") {
                plainAppUrl = String(plainAppUrl.dropLast())
            }
            let wcPath = plainAppUrl.hasSuffix("/wc") ? "" : "/wc"
            let urlString = "\(plainAppUrl)\(wcPath)?requestId=\(request.id.string)&sessionTopic=\(request.topic)"
            if let url = URL(string: urlString) {
                UIApplication.shared.open(url)
            }
            return
        }

        if let url = URL(string: plainAppUrl) {
            UIApplication.shared.open(url)
        }
    }

    func session(for topic: String?) -> Session? {
        guard isConfigured else {
            return nil
        }

        let sessions = Sign.instance.getSessions()
        if let topic {
            return sessions.first { $0.topic == topic }
        }
        return sessions.first
    }

    func sessionPayloads() -> [JSObject] {
        guard isConfigured else {
            return []
        }

        return Sign.instance.getSessions().map { sessionPayload($0) }
    }

    func currentState() -> JSObject {
        guard isConfigured else {
            return disconnectedState
        }

        let session = session(for: nil)
        let accounts = session?.namespaces.values.flatMap { namespace in
            namespace.accounts.map { $0.address }
        } ?? []

        var payload: JSObject = [
            "configured": isConfigured,
            "connected": session != nil,
            "accounts": accounts
        ]

        if let topic = session?.topic {
            payload["topic"] = topic
        }
        if let address = accounts.first {
            payload["address"] = address
        }
        if let chainId = firstChainId(in: session) {
            payload["chainId"] = chainId
        }
        if let walletName = session?.peer.name {
            payload["walletName"] = walletName
        }
        if let socketStatus {
            payload["socketStatus"] = socketStatus
        }

        return payload
    }

    func sessionPayload(_ session: Session) -> JSObject {
        let accounts = session.namespaces.values.flatMap { namespace in
            namespace.accounts.map { $0.address }
        }

        var payload: JSObject = [
            "topic": session.topic,
            "accounts": accounts,
            "walletName": session.peer.name
        ]

        if let address = accounts.first {
            payload["address"] = address
        }
        if let chainId = firstChainId(in: session) {
            payload["chainId"] = chainId
        }

        return payload
    }

    func notifyStateChanged() {
        notifyListeners("stateChanged", data: currentState())
    }

    func firstAddress(in session: Session) -> String? {
        session.namespaces.values.first?.accounts.first?.address
    }

    func firstChainId(in session: Session?) -> Int? {
        guard let blockchainIdentifier = session?.namespaces.values.first?.accounts.first?.blockchainIdentifier else {
            return nil
        }
        guard let chainId = blockchainIdentifier.split(separator: ":").last else {
            return nil
        }
        return Int(chainId)
    }
}
