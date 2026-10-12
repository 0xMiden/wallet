import UIKit
import WebKit

struct BreadPresentationOptions {
    let script: String
    let backLabel: String
    let hintLabel: String
    let retryLabel: String
    let errorLabel: String
    let timeout: TimeInterval

    init?(_ values: [String: Any]?) {
        guard let values, let script = values["script"] as? String,
              let back = values["backLabel"] as? String, let hint = values["hintLabel"] as? String,
              let retry = values["retryLabel"] as? String, let error = values["errorLabel"] as? String else { return nil }
        self.script = script
        backLabel = back
        hintLabel = hint
        retryLabel = retry
        errorLabel = error
        timeout = 30
    }
}

final class BreadPresentationController: NSObject {
    let state: BreadPresentationState
    private let options: BreadPresentationOptions
    private weak var owner: WKWebViewController?
    private weak var webView: WKWebView?
    private weak var instance: WKWebViewInstance?
    private weak var hostWindow: UIWindow?
    private let cover = UIView()
    private let button = UIButton(type: .system)
    private let capsuleBackground = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    private var revealAnimator: UIViewPropertyAnimator?
    private let hint = UILabel()
    private let errorLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .large)
    private var timer: Timer?
    private var lastTick = ProcessInfo.processInfo.systemUptime
    private var token: String?
    private var lastMetricKey: String?
    private var metricRevision = 0
    private var layoutRevision = 0
    private var preparingRevision: Int?
    private var lastBounds = CGRect.zero
    private var observers: [NSObjectProtocol] = []
    private var rotating = false
    private var navigationCommitted = false
    private var notifiedPolicyRevision: Int?
    private var hintDeadline: TimeInterval?

    init(options: BreadPresentationOptions, owner: WKWebViewController, webView: WKWebView) {
        self.options = options
        self.owner = owner
        self.webView = webView
        state = BreadPresentationState(timeout: options.timeout, initiallyVisible: owner.initiallyVisible)
        super.init()
        installControls(in: owner.view)
        state.setForeground(UIApplication.shared.applicationState == .active)
        for name in [UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let self else { return }
                self.tick()
                self.state.setForeground(note.name == UIApplication.didBecomeActiveNotification)
                self.invalidateLayout()
                self.lastTick = ProcessInfo.processInfo.systemUptime
                self.render()
            })
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.tick() }
    }

    deinit { timer?.invalidate(); observers.forEach(NotificationCenter.default.removeObserver) }

    var immersive: Bool { state.display == .fullscreen && state.effectiveVisibility }

    func attach(_ instance: WKWebViewInstance, hostWindow: UIWindow?) {
        self.instance = instance
        self.hostWindow = hostWindow
        render()
    }

    func beginNavigation() {
        tick()
        state.beginNavigation()
        token = nil
        lastMetricKey = nil
        navigationCommitted = false
        applyTheme(nil)
        invalidateLayout()
        render()
    }

    func committed() { navigationCommitted = true }

    func failed() { state.fail(generation: state.generation); render() }

    func setVisible(_ visible: Bool, policyRevision: Int? = nil, sequence: Int? = nil) {
        tick()
        let wasVisible = state.effectiveVisibility
        guard state.requestVisibility(visible, policyRevision: policyRevision, sequence: sequence) else { return }
        if state.effectiveVisibility != wasVisible { invalidateLayout() }
        render()
    }

    func updateSlot() { if state.display == .browser { render() } }

    func layoutChanged() {
        guard let owner, state.phase != .closed else { return }
        if lastBounds != owner.view.bounds {
            lastBounds = owner.view.bounds
            invalidateLayout()
        }
        layoutControls()
        publishMetrics()
        preparePaint()
    }

    func transition(with coordinator: UIViewControllerTransitionCoordinator) {
        rotating = true
        invalidateLayout()
        render()
        coordinator.animate(alongsideTransition: { [weak self] _ in self?.render() }) { [weak self] _ in
            guard let self else { return }
            self.rotating = false
            self.invalidateLayout()
            self.render()
        }
    }

    func receive(_ message: WKScriptMessage) {
        guard owner?.managedClose?.closing != true else { return }
        guard navigationCommitted, message.frameInfo.isMainFrame, let webView, state.phase != .closed,
              let body = message.body as? String, let data = body.data(using: .utf8),
              let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let messageToken = envelope["token"] as? String, let type = envelope["type"] as? String else { return }
        let generation = state.generation
        webView.evaluateJavaScript("window.__breadPresentationToken") { [weak self] result, error in
            guard let self, error == nil, self.state.phase != .closed, self.owner?.managedClose?.closing != true,
                  BreadPresentationState.acceptsMessage(mainFrame: message.frameInfo.isMainFrame,
                    messageToken: messageToken, documentToken: result as? String,
                    startedGeneration: generation, currentGeneration: self.state.generation) else { return }
            self.token = messageToken
            switch type {
            case "configure":
                let previousPolicy = self.state.policyRevision
                guard let raw = envelope["display"] as? String,
                      let display = BreadPresentationState.Display(rawValue: raw),
                      self.state.configure(display, generation: generation) else { return }
                self.applyTheme(envelope["themeColor"] as? String)
                if previousPolicy != self.state.policyRevision { self.invalidateLayout() }
                self.publishMetrics()
                self.render()
            case "ready":
                let accepted = self.state.ready(generation: generation)
                self.respond(envelope, ok: accepted)
                self.render()
            case "close":
                self.respond(envelope, ok: true) { [weak self] in
                    guard let self, self.state.generation == generation, self.state.phase != .closed else { return }
                    self.owner?.closeView()
                }
            default: break
            }
        }
    }

    private func respond(_ envelope: [String: Any], ok: Bool, completion: (() -> Void)? = nil) {
        guard let token = envelope["token"] as? String, let requestId = envelope["requestId"] as? String,
              let data = try? JSONSerialization.data(withJSONObject: ["token": token, "requestId": requestId, "ok": ok]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__breadPresentationRespond(\(json))") { _, _ in completion?() }
    }

    private func invalidateLayout() {
        guard owner?.managedClose?.closing != true else { return }
        layoutRevision += 1
        preparingRevision = nil
        state.invalidateLayout()
        cancelReveal()
    }

    private func applyTheme(_ color: String?) {
        var background = UIColor.systemBackground
        var foreground = UIColor.label
        if let color, color.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil {
            background = UIColor(hexString: color)
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            background.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            foreground = 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.5 ? .white : .black
        }
        cover.backgroundColor = background
        spinner.color = foreground
        errorLabel.textColor = foreground
        retryButton.setTitleColor(foreground, for: .normal)
    }

    private func cancelReveal() {
        revealAnimator?.stopAnimation(true)
        revealAnimator = nil
        cover.alpha = 1
        cover.isHidden = false
        webView?.accessibilityElementsHidden = true
    }

    private func reveal() {
        guard !cover.isHidden, revealAnimator == nil else { return }
        if UIAccessibility.isReduceMotionEnabled {
            cover.isHidden = true
            webView?.accessibilityElementsHidden = false
            return
        }
        let generation = state.generation
        let revision = layoutRevision
        let animator = UIViewPropertyAnimator(duration: 0.18, curve: .easeOut) { [weak self] in
            self?.cover.alpha = 0
        }
        revealAnimator = animator
        animator.addCompletion { [weak self, weak animator] position in
            guard let self, let animator, self.revealAnimator === animator,
                  position == .end, self.state.generation == generation,
                  self.layoutRevision == revision, self.state.phase == .visible else { return }
            self.revealAnimator = nil
            self.cover.isHidden = true
            self.cover.alpha = 1
            self.webView?.accessibilityElementsHidden = false
        }
        animator.startAnimation()
    }

    private func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        state.elapse(now - lastTick)
        lastTick = now
        if let deadline = hintDeadline, now >= deadline { hint.isHidden = true }
        if state.phase == .error { render() }
    }

    private func publishPolicy() {
        guard notifiedPolicyRevision != state.policyRevision, let owner else { return }
        notifiedPolicyRevision = state.policyRevision
        var data: [String: Any] = ["id": owner.instanceId ?? "", "display": state.display.rawValue,
            "policyResolved": state.policyResolved, "policyRevision": state.policyRevision]
        if let lifetime = owner.managedClose?.token { data["managedHostCloseToken"] = lifetime }
        owner.capBrowserPlugin?.notifyListeners("presentationChanged", data: data)
    }

    private func render() {
        guard owner?.managedClose?.closing != true else { return }
        guard state.phase != .closed, let owner else { return }
        publishPolicy()
        if let window = instance?.containerWindow {
            let frame = state.display == .fullscreen ? window.windowScene?.coordinateSpace.bounds : instance?.rect
            if let frame, !frame.isEmpty, window.frame != frame, state.display != .fullscreen || !rotating {
                window.frame = frame
                invalidateLayout()
            }
            window.backgroundColor = cover.backgroundColor
            window.accessibilityViewIsModal = immersive
            window.isHidden = !state.effectiveVisibility
            if immersive && state.foreground { window.makeKey() }
            else if window.isKeyWindow { hostWindow?.makeKey() }
        }
        owner.setNeedsStatusBarAppearanceUpdate()
        owner.setNeedsUpdateOfHomeIndicatorAutoHidden()
        owner.navigationController?.setNeedsStatusBarAppearanceUpdate()
        owner.navigationController?.setNeedsUpdateOfHomeIndicatorAutoHidden()
        hostWindow?.rootViewController?.setNeedsStatusBarAppearanceUpdate()
        if state.phase == .visible { reveal() } else { cancelReveal() }
        let failed = state.phase == .error
        errorLabel.isHidden = !failed
        retryButton.isHidden = !failed
        spinner.isHidden = failed
        if !failed { spinner.startAnimating() } else { spinner.stopAnimating() }
        button.isHidden = state.display != .fullscreen && state.phase == .visible
        capsuleBackground.isHidden = button.isHidden
        if state.display == .fullscreen && hintDeadline == nil {
            hintDeadline = ProcessInfo.processInfo.systemUptime + 5
            hint.isHidden = false
        }
        if state.display != .fullscreen { hint.isHidden = true }
        layoutControls()
        owner.view.setNeedsLayout()
        publishMetrics()
        preparePaint()
    }

    static let metricScript = """
        if (window.__breadPresentationToken !== token) return false;
        const previous = window.__breadNativeMetrics;
        if (previous?.token === token && previous.revision > revision) return false;
        const metrics = {token, revision, display, inset, width};
        window.__breadNativeMetrics = metrics;
        if (!window.__breadReprojectMetrics) {
            window.__breadReprojectMetrics = () => {
                const current = window.__breadNativeMetrics;
                if (!current || window.__breadPresentationToken !== current.token) return;
                const controlInsetTop = current.inset * innerWidth / current.width;
                if (current.projectedInset === controlInsetTop) return;
                current.projectedInset = controlInsetTop;
                window.__breadPresentationUpdate({token: current.token, display: current.display, controlInsetTop});
            };
            addEventListener('resize', window.__breadReprojectMetrics);
        }
        const isCurrent = () => window.__breadPresentationToken === token &&
            window.__breadNativeMetrics.token === token && window.__breadNativeMetrics.revision === revision;
        window.__breadReprojectMetrics();
        if (!fence) return true;
        return await new Promise(resolve => requestAnimationFrame(() => {
            if (!isCurrent()) { resolve(false); return; }
            window.__breadReprojectMetrics();
            const paintedWidth = innerWidth;
            requestAnimationFrame(() => resolve(isCurrent() && innerWidth === paintedWidth));
        }));
        """

    private func metricArguments() -> [String: Any]? {
        guard let token, let webView, !webView.bounds.isEmpty else { return nil }
        let inset = state.display == .fullscreen ? button.frame.maxY + 8 : 0
        let key = "\(token):\(layoutRevision):\(state.display.rawValue):\(inset):\(webView.bounds.width)"
        if key != lastMetricKey {
            lastMetricKey = key
            metricRevision += 1
        }
        return ["token": token, "revision": metricRevision, "display": state.display.rawValue,
                "inset": inset, "width": webView.bounds.width, "fence": false]
    }

    private func publishMetrics() {
        let previousRevision = metricRevision
        guard let arguments = metricArguments(), metricRevision != previousRevision else { return }
        webView?.callAsyncJavaScript(Self.metricScript, arguments: arguments, in: nil, in: .page)
    }

    private func preparePaint() {
        guard let owner, let webView, token != nil, !rotating, state.phase == .preparing,
              state.documentReady, webView.window != nil, !webView.bounds.isEmpty,
              preparingRevision != layoutRevision else { return }
        let revision = layoutRevision
        let generation = state.generation
        preparingRevision = revision
        owner.view.layoutIfNeeded()
        guard var arguments = metricArguments() else { preparingRevision = nil; return }
        let metrics = metricRevision
        arguments["fence"] = true
        // Reproject after viewport layout, then fence the resulting WebKit paint before revealing it.
        webView.callAsyncJavaScript(Self.metricScript, arguments: arguments, in: nil, in: .page) { [weak self] result in
                guard let self, self.state.generation == generation, self.layoutRevision == revision,
                      self.state.phase == .preparing else { return }
                guard case .success(let value) = result, (value as? Bool) == true,
                      self.metricRevision == metrics else {
                    self.preparingRevision = nil
                    if case .success = result { self.preparePaint() }
                    return
                }
                let configuration = WKSnapshotConfiguration()
                configuration.afterScreenUpdates = true
                webView.takeSnapshot(with: configuration) { [weak self] image, error in
                    guard let self, self.state.generation == generation, self.layoutRevision == revision,
                          self.state.phase == .preparing else { return }
                    self.preparingRevision = nil
                    guard self.metricRevision == metrics else { self.preparePaint(); return }
                    guard image != nil, error == nil else { return }
                    self.state.layoutPrepared(generation: generation)
                    self.render()
                }
        }
    }

    private func installControls(in view: UIView) {
        applyTheme(nil)
        cover.isOpaque = true
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(cover)
        errorLabel.text = options.errorLabel
        errorLabel.font = .preferredFont(forTextStyle: .body)
        errorLabel.adjustsFontForContentSizeCategory = true
        errorLabel.numberOfLines = 0
        errorLabel.textAlignment = .center
        retryButton.setTitle(options.retryLabel, for: .normal)
        retryButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [spinner, errorLabel, retryButton])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        cover.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
            stack.widthAnchor.constraint(equalTo: cover.widthAnchor, multiplier: 0.8),
            retryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48)
        ])
        button.accessibilityLabel = options.backLabel
        button.accessibilityIdentifier = "bread-presentation-close"
        capsuleBackground.isUserInteractionEnabled = false
        capsuleBackground.accessibilityElementsHidden = true
        capsuleBackground.layer.cornerRadius = 24
        capsuleBackground.clipsToBounds = true
        view.addSubview(capsuleBackground)
        button.backgroundColor = .clear
        button.layer.cornerRadius = 24
        button.imageView?.contentMode = .scaleAspectFit
        for directory in ["public", "www"] {
            if let url = Bundle.main.resourceURL?.appendingPathComponent(directory + "/misc/logo-white-bg.png"),
               let image = UIImage(contentsOfFile: url.path) {
                button.setImage(image.withRenderingMode(.alwaysOriginal), for: .normal)
                break
            }
        }
        button.imageEdgeInsets = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        button.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        view.addSubview(button)
        hint.text = options.hintLabel
        hint.font = .preferredFont(forTextStyle: .caption1)
        hint.adjustsFontForContentSizeCategory = true
        hint.textColor = .label
        hint.backgroundColor = .secondarySystemBackground
        hint.layer.cornerRadius = 8
        hint.clipsToBounds = true
        hint.textAlignment = .center
        hint.isHidden = true
        view.addSubview(hint)
        render()
    }

    private func layoutControls() {
        guard let view = owner?.view else { return }
        cover.frame = view.bounds
        let safe = view.safeAreaInsets
        button.frame = CGRect(x: safe.left + 12, y: safe.top + 8, width: 64, height: 48)
        capsuleBackground.frame = button.frame
        let hintSize = hint.sizeThatFits(CGSize(width: max(0, view.bounds.width - safe.left - safe.right - 112), height: 80))
        hint.frame = CGRect(x: button.frame.maxX + 8, y: button.frame.midY - (hintSize.height + 16) / 2,
                            width: hintSize.width + 16, height: hintSize.height + 16)
    }

    @objc private func retry() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        beginNavigation()
        owner?.reload()
    }

    @objc private func closeTapped() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        owner?.closeView()
    }

    func close() {
        guard state.close() else { return }
        cancelReveal()
        timer?.invalidate()
        timer = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        if instance?.containerWindow?.isKeyWindow == true { hostWindow?.makeKey() }
        hostWindow?.rootViewController?.setNeedsStatusBarAppearanceUpdate()
        hostWindow?.rootViewController?.setNeedsUpdateOfHomeIndicatorAutoHidden()
    }
}
