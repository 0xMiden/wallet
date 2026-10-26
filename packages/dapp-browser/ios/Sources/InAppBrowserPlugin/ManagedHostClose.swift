import UIKit
import WebKit

final class ManagedHostClose {
    let token: String
    private(set) var requestID: String?
    private(set) var failed = false
    private(set) var finished = false
    var closing: Bool { requestID != nil && !finished }
    private weak var instance: WKWebViewInstance?
    private let host: () -> WKWebView?
    private let notify: ([String: Any]) -> Void
    private let finish: () -> Void
    private let labels: [String: Any]
    private var completions: [() -> Void] = []
    private var timer: Timer?
    private var lastTick = ProcessInfo.processInfo.systemUptime
    private var remaining: TimeInterval = 5
    private var visible = false
    private var generation = 0
    private var receipt: Int?
    private var fence: Int?
    private var geometry: String?
    private var failureView: UIView?
    private var observers: [NSObjectProtocol] = []

    init?(options: [String: Any]?, instance: WKWebViewInstance, host: @escaping () -> WKWebView?,
          notify: @escaping ([String: Any]) -> Void, finish: @escaping () -> Void) {
        guard let options, let token = options["token"] as? String, !token.isEmpty else { return nil }
        self.token = token
        labels = options
        self.instance = instance
        self.host = host
        self.notify = notify
        self.finish = finish
        for name in [UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                self.generation += 1
                self.fence = nil
                self.lastTick = ProcessInfo.processInfo.systemUptime
                self.startFence()
            })
        }
    }

    deinit { timer?.invalidate(); observers.forEach(NotificationCenter.default.removeObserver) }

    func request(completion: @escaping () -> Void = {}) {
        guard !finished else { completion(); return }
        completions.append(completion)
        if closing { if failed { retry() }; return }
        visible = instance?.isVisible == true && instance?.containerWindow?.isHidden == false
        instance?.controller.breadPresentation?.managedCloseStarted()
        instance?.controller.webViewForManagedClose?.isUserInteractionEnabled = false
        retry()
    }

    func retry() {
        guard !finished else { return }
        failed = false
        failureView?.removeFromSuperview()
        failureView = nil
        requestID = UUID().uuidString
        remaining = 5
        receipt = nil
        generation += 1
        fence = nil
        lastTick = ProcessInfo.processInfo.systemUptime
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        guard let instance, let requestID else { force(); return }
        notify(["id": instance.id, "token": token, "requestId": requestID, "visible": visible])
    }

    func complete(token: String, requestID: String, commit: Int) -> Bool {
        guard self.token == token, self.requestID == requestID, closing, !failed,
              receipt == nil || commit > receipt! else { return false }
        receipt = commit
        generation += 1
        fence = nil
        if !visible { force(); return true }
        startFence()
        return true
    }

    func layoutChanged() {
        guard closing else { return }
        if let instance, instance.controller.breadPresentation?.state.display == .fullscreen,
           let window = instance.containerWindow, let bounds = window.windowScene?.coordinateSpace.bounds,
           window.frame != bounds { window.frame = bounds }
        let next = hostGeometry()
        guard next != geometry else { return }
        geometry = next
        generation += 1
        fence = nil
        startFence()
    }

    private func hostGeometry() -> String {
        guard let web = host() else { return "detached" }
        return "\(web.bounds):\(web.safeAreaInsets):\(web.window?.windowScene?.coordinateSpace.bounds ?? .zero)"
    }

    private func startFence() {
        guard closing, !failed, receipt != nil, fence == nil, UIApplication.shared.applicationState == .active,
              let instance, let web = host(), let window = web.window, !window.isHidden,
              !web.bounds.isEmpty else { return }
        // Restore the destination's native ownership while the original surface still covers it.
        window.makeKey()
        window.rootViewController?.setNeedsStatusBarAppearanceUpdate()
        window.rootViewController?.setNeedsUpdateOfHomeIndicatorAutoHidden()
        window.layoutIfNeeded()
        web.layoutIfNeeded()
        geometry = hostGeometry()
        let revision = generation
        let bounds = web.bounds
        let insets = web.safeAreaInsets
        let scene = window.windowScene
        fence = revision
        web.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));", arguments: [:], in: nil, in: .page) { [weak self, weak web, weak window, weak instance] result in
            guard let self, let web, let window, let instance, self.isCurrent(revision, web: web, window: window, instance: instance) else { return }
            guard case .success = result else { self.fail(); return }
            let configuration = WKSnapshotConfiguration()
            configuration.afterScreenUpdates = true
            web.takeSnapshot(with: configuration) { [weak self, weak web, weak window, weak instance] image, error in
                guard let self, let web, let window, let instance, self.isCurrent(revision, web: web, window: window, instance: instance) else { return }
                guard error == nil, image != nil else { self.fail(); return }
                guard web.bounds == bounds, web.safeAreaInsets == insets, window.windowScene === scene else {
                    self.layoutChanged(); return
                }
                self.force()
            }
        }
    }

    private func isCurrent(_ revision: Int, web: WKWebView, window: UIWindow, instance: WKWebViewInstance) -> Bool {
        closing && !failed && generation == revision && host() === web && web.window === window &&
            WebViewRegistry.shared.get(id: instance.id) === instance && UIApplication.shared.applicationState == .active
    }

    private func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        defer { lastTick = now }
        guard closing, !failed else { return }
        if host() == nil { force(); return }
        if UIApplication.shared.applicationState == .active { remaining -= now - lastTick }
        if remaining <= 0 { fail() }
        else { layoutChanged(); startFence() }
    }

    var userActionFeedback: () -> Void = { UIImpactFeedbackGenerator(style: .light).impactOccurred() }

    private func fail() {
        guard closing, !failed else { return }
        if !visible { force(); return }
        failed = true
        generation += 1
        timer?.invalidate()
        guard let view = instance?.controller.view else { force(); return }
        let panel = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
        panel.layer.cornerRadius = 16
        panel.clipsToBounds = true
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 8
        let message = UILabel()
        message.text = labels["errorLabel"] as? String
        message.font = .preferredFont(forTextStyle: .body)
        message.numberOfLines = 0
        let retry = UIButton(type: .system)
        retry.setTitle(labels["retryLabel"] as? String, for: .normal)
        retry.addAction(UIAction { [weak self] _ in self?.userActionFeedback(); self?.retry() }, for: .touchUpInside)
        let exit = UIButton(type: .system)
        exit.setTitle(labels["exitLabel"] as? String, for: .normal)
        exit.accessibilityIdentifier = "bread-close-exit-now"
        exit.addAction(UIAction { [weak self] _ in self?.userActionFeedback(); self?.force() }, for: .touchUpInside)
        [message, retry, exit].forEach(stack.addArrangedSubview)
        panel.contentView.addSubview(stack)
        view.addSubview(panel)
        panel.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            panel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            panel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            panel.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -32),
            stack.topAnchor.constraint(equalTo: panel.contentView.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: panel.contentView.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: panel.contentView.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: panel.contentView.trailingAnchor, constant: -16),
            retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            exit.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        failureView = panel
        UIAccessibility.post(notification: .layoutChanged, argument: message)
    }

    func force() {
        guard !finished else { return }
        finished = true
        generation += 1
        timer?.invalidate()
        timer = nil
        failureView?.removeFromSuperview()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        finish()
        let callbacks = completions
        completions.removeAll()
        callbacks.forEach { $0() }
    }
}
