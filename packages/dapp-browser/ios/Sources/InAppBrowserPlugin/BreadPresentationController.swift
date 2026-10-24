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
        timeout = TimeInterval(max(1, (values["readinessTimeoutMs"] as? NSNumber)?.int64Value ?? 30000)) / 1000
    }
}

enum BreadMorphTarget: String { case collapsed, expanded }
enum BreadMorphPhase: String { case started, retargeted, settled, cancelled }

final class BreadPresentationController: NSObject {
    let state: BreadPresentationState
    let proxy = UIImageView()
    private(set) var animator: BreadMorphAnimator?
    private(set) var morphId: String?
    private let options: BreadPresentationOptions
    private weak var owner: WKWebViewController?
    private weak var webView: WKWebView?
    private weak var instance: WKWebViewInstance?
    private weak var hostWindow: UIWindow?
    private let cover = UIView()
    private let button = UIButton(type: .system)
    private let capsuleBackground = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    private var revealAnimator: UIViewPropertyAnimator?
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
    private var lastSafeArea = UIEdgeInsets.zero
    private var morphSequence = 0
    private var proxyCovering = false
    private var proxyFresh = false
    private var proxyFade: UIViewPropertyAnimator?

    init(options: BreadPresentationOptions, owner: WKWebViewController, webView: WKWebView) {
        self.options = options
        self.owner = owner
        self.webView = webView
        state = BreadPresentationState(timeout: options.timeout, initiallyVisible: owner.initiallyVisible)
        super.init()
        installControls(in: owner.view)
        state.setForeground(UIApplication.shared.applicationState == .active)
        for name in [UIApplication.willResignActiveNotification, UIApplication.willEnterForegroundNotification, UIApplication.didBecomeActiveNotification] {
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

    var immersive: Bool { state.display == .fullscreen && state.surfaceVisibility && !moving }
    private var moving: Bool { state.motion != .none }
    private var heading: BreadMorphTarget { state.motion == .collapsing ? .collapsed : .expanded }
    private var proxyAvailable: Bool {
        guard state.proxyUsable, state.foreground, let image = proxy.image, let webView else { return false }
        return abs(image.size.width - webView.bounds.width) < 1 && abs(image.size.height - webView.bounds.height) < 1
    }

    func preparePrivacyCover() -> Bool {
        guard owner?.managedClose?.closing != true, let window = instance?.containerWindow,
              !window.isHidden, window.isKeyWindow else { return false }
        tick()
        state.setForeground(false)
        invalidateLayout()
        window.layoutIfNeeded()
        render()
        return immersive && !window.isHidden && window.isKeyWindow && cover.isOpaque
            && !cover.isHidden && cover.alpha == 1 && cover.frame == owner?.view.bounds
    }

    func attach(_ instance: WKWebViewInstance, hostWindow: UIWindow?) {
        self.instance = instance
        self.hostWindow = hostWindow
        if animator == nil, let container = instance.morphContainer {
            let animator = BreadMorphAnimator(container: container)
            animator.companions = [capsuleBackground.layer, button.layer]
            self.animator = animator
        }
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

    @discardableResult
    func morph(to target: BreadMorphTarget, card: BreadMorphCard?, velocity: CGPoint, morphId id: String,
               policyRevision: Int?, sequence: Int?) -> Bool {
        animator?.boost()
        let accepted = startMorph(target, card: card, velocity: velocity, id: id, policyRevision: policyRevision, sequence: sequence)
        if !accepted {
            if moving { animator?.releaseBoost() } else { animator?.reset() }
        }
        return accepted
    }

    func slotFrame() -> CGRect? { instance?.containerWindow.flatMap { slotFrame(for: $0) } }

    func dropProxy() {
        proxy.image = nil
        proxyFresh = false
        state.dropProxy()
        if proxyCovering { cancelReveal() }
    }

    func adoptProxy(_ image: UIImage) {
        proxy.image = image
        state.captureProxy()
        proxyFresh = true
        if let id = instance?.id { WebViewRegistry.shared.retainProxy(for: id) }
    }

    private func startMorph(_ target: BreadMorphTarget, card: BreadMorphCard?, velocity: CGPoint, id: String,
                            policyRevision: Int?, sequence: Int?) -> Bool {
        guard owner?.managedClose?.closing != true, state.phase != .closed, let animator,
              let window = instance?.containerWindow, !id.isEmpty else { return false }
        let wasVisible = state.effectiveVisibility
        let wasMoving = moving
        guard target == .expanded else { return false }
        guard state.requestVisibility(true, policyRevision: policyRevision, sequence: sequence) else { return false }
        guard state.surfaceVisibility else {
            if state.effectiveVisibility != wasVisible { invalidateLayout() }
            render()
            return false
        }
        let previous = morphId
        let fromRest = !wasMoving && window.isHidden
        if !wasMoving, applySlotFrame(window) { window.layoutIfNeeded() }
        let landing = card.flatMap { fits($0, in: window.bounds.size) ? $0 : nil }
        let progressVelocity = previous != nil ? animator.velocity()
            : landing.map { BreadMorphGeometry.progressVelocity(velocity, card: $0.rect, slot: window.bounds) } ?? 0
        state.beginMotion(.expanding)
        morphSequence = sequence ?? state.acknowledgedVisibilitySequence
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if fromRest { animator.hold(0, card: landing) }
        beginExpandVisuals(fromRest: fromRest)
        if state.effectiveVisibility != wasVisible { invalidateLayout() }
        render()
        CATransaction.commit()
        morphId = id
        run(to: .expanded, card: landing, velocity: progressVelocity, physics: .expand)
        if previous != nil {
            emit(.retargeted, id: id, target: .expanded, progress: animator.progress(), velocity: animator.velocity())
        } else {
            emitStarted(id)
        }
        return true
    }

    private func fits(_ card: BreadMorphCard, in size: CGSize) -> Bool {
        card.rect.width > 0 && card.rect.height > 0 && CGRect(origin: .zero, size: size).insetBy(dx: -0.5, dy: -0.5).contains(card.rect)
    }

    private func run(to target: BreadMorphTarget, card: BreadMorphCard?, velocity: Double, physics: BreadMorphPhysics) {
        guard let animator, let id = morphId else { return }
        animator.run(to: target == .expanded ? 1 : 0, card: card, velocity: velocity, physics: physics) { [weak self] in
            self?.motionSettled(id, at: target)
        }
    }

    private func beginExpandVisuals(fromRest: Bool) {
        webView?.isUserInteractionEnabled = false
        proxyFresh = false
        if fromRest {
            proxyFade?.stopAnimation(true)
            proxyFade = nil
            cancelReveal()
        } else if !proxyCovering, !proxy.isHidden {
            fadeProxy(to: 0, duration: 0.12)
        }
    }

    private func fadeProxy(to alpha: CGFloat, duration: TimeInterval) {
        proxyFade?.stopAnimation(true)
        let fade = UIViewPropertyAnimator(duration: duration, curve: alpha > 0 ? .linear : .easeOut) { [weak self] in
            self?.proxy.alpha = alpha
        }
        fade.addCompletion { [weak self, weak fade] position in
            guard let self, let fade, self.proxyFade === fade else { return }
            self.proxyFade = nil
            if position == .end, alpha == 0, !self.proxyCovering { self.proxy.isHidden = true }
        }
        proxyFade = fade
        fade.startAnimation()
    }

    private func motionSettled(_ id: String, at end: BreadMorphTarget) {
        guard morphId == id else { return }
        completeMotion(at: end)
        render()
    }

    @discardableResult private func completeMotion(at end: BreadMorphTarget) -> Bool {
        guard let id = morphId else { return false }
        morphId = nil
        if end == .expanded {
            state.endMotion()
            webView?.isUserInteractionEnabled = true
            if !proxyCovering, proxyFade == nil { proxy.isHidden = true }
        } else if proxyAvailable, !proxyCovering, !UIAccessibility.isReduceMotionEnabled {
            proxyFade?.stopAnimation(true)
            proxyFade = nil
            proxy.isHidden = false
            proxy.alpha = 1
        }
        emit(.settled, id: id, target: end, progress: end == .expanded ? 1 : 0, velocity: 0)
        if end == .expanded { UIAccessibility.post(notification: .screenChanged, argument: webView) }
        return true
    }

    private func emitStarted(_ id: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.morphId == id, let animator = self.animator else { return }
            self.emit(.started, id: id, target: self.heading, progress: animator.progress(), velocity: animator.velocity())
        }
    }

    private func emit(_ phase: BreadMorphPhase, id: String, target: BreadMorphTarget, progress: Double, velocity: Double,
                      tracking: Bool = false) {
        guard let owner, owner.managedClose?.closing != true, state.phase != .closed else { return }
        var data: [String: Any] = ["id": owner.instanceId, "morphId": id, "phase": phase.rawValue, "target": target.rawValue,
            "progress": progress, "velocity": velocity, "tracking": tracking, "visibilitySequence": morphSequence]
        if let lifetime = owner.managedClose?.token { data["managedHostCloseToken"] = lifetime }
        owner.capBrowserPlugin?.notifyListeners("presentationMorph", data: data)
    }

    func handleTap() {}

    func handleGrab(_ phase: UIGestureRecognizer.State, translation: CGPoint, velocity: CGPoint) {}

    func layoutChanged() {
        guard let owner, state.phase != .closed else { return }
        if lastBounds != owner.view.bounds || lastSafeArea != owner.view.safeAreaInsets {
            lastBounds = owner.view.bounds
            lastSafeArea = owner.view.safeAreaInsets
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
        proxyFade?.stopAnimation(true)
        proxyFade = nil
        // The snapshot stands in for the cover until a fresh fenced paint, never for the privacy cover.
        if (proxyCovering || moving) && proxyAvailable {
            proxyCovering = true
            proxy.alpha = 1
            proxy.isHidden = false
            cover.isHidden = true
        } else {
            proxyCovering = false
            proxy.isHidden = true
            cover.alpha = 1
            cover.isHidden = false
        }
        webView?.accessibilityElementsHidden = true
    }

    private func reveal() {
        let veil: UIView = proxyCovering ? proxy : cover
        guard !veil.isHidden, revealAnimator == nil else { return }
        let covering = proxyCovering
        if UIAccessibility.isReduceMotionEnabled {
            veil.isHidden = true
            proxyCovering = false
            webView?.accessibilityElementsHidden = false
            return
        }
        let generation = state.generation
        let revision = layoutRevision
        let animator = UIViewPropertyAnimator(duration: covering ? 0.12 : 0.18, curve: .easeOut) {
            veil.alpha = 0
        }
        revealAnimator = animator
        animator.addCompletion { [weak self, weak animator] position in
            guard let self, let animator, self.revealAnimator === animator,
                  position == .end, self.state.generation == generation,
                  self.layoutRevision == revision, self.state.phase == .visible else { return }
            self.revealAnimator = nil
            veil.isHidden = true
            veil.alpha = 1
            if covering { self.proxyCovering = false }
            self.webView?.accessibilityElementsHidden = false
        }
        animator.startAnimation()
    }

    private func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        state.elapse(now - lastTick)
        lastTick = now
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
            applySlotFrame(window)
            window.backgroundColor = moving ? .clear : cover.backgroundColor
            instance?.morphContainer?.clipView.backgroundColor = cover.backgroundColor
            window.accessibilityViewIsModal = immersive
            window.isHidden = !state.surfaceVisibility
            if immersive { window.makeKey() }
            else if window.isKeyWindow { hostWindow?.makeKey() }
        }
        owner.setNeedsStatusBarAppearanceUpdate()
        owner.setNeedsUpdateOfHomeIndicatorAutoHidden()
        owner.navigationController?.setNeedsStatusBarAppearanceUpdate()
        owner.navigationController?.setNeedsUpdateOfHomeIndicatorAutoHidden()
        instance?.morphContainer?.setNeedsStatusBarAppearanceUpdate()
        instance?.morphContainer?.setNeedsUpdateOfHomeIndicatorAutoHidden()
        hostWindow?.rootViewController?.setNeedsStatusBarAppearanceUpdate()
        if state.phase == .visible { reveal() } else { cancelReveal() }
        let failed = state.phase == .error
        errorLabel.isHidden = !failed
        retryButton.isHidden = !failed
        spinner.isHidden = failed
        if !failed { spinner.startAnimating() } else { spinner.stopAnimating() }
        button.isHidden = state.display != .fullscreen && state.phase == .visible
        capsuleBackground.isHidden = button.isHidden
        layoutControls()
        owner.view.setNeedsLayout()
        publishMetrics()
        preparePaint()
    }

    private func slotFrame(for window: UIWindow) -> CGRect? {
        state.display == .fullscreen ? window.windowScene?.coordinateSpace.bounds : instance?.rect
    }

    @discardableResult private func applySlotFrame(_ window: UIWindow) -> Bool {
        guard let frame = slotFrame(for: window), !frame.isEmpty, window.frame != frame,
              state.display != .fullscreen || !rotating else { return false }
        window.frame = frame
        invalidateLayout()
        return true
    }

    static let metricScript = """
        if (window.__breadPresentationToken !== token) return false;
        const previous = window.__breadNativeMetrics;
        if (previous?.token === token && previous.revision > revision) return false;
        const metrics = {token, revision, display, inset, width, controlBounds, safeAreaInsets};
        window.__breadNativeMetrics = metrics;
        if (!window.__breadReprojectMetrics) {
            window.__breadReprojectMetrics = () => {
                const current = window.__breadNativeMetrics;
                if (!current || window.__breadPresentationToken !== current.token) return;
                const scale = innerWidth / current.width;
                const controlInsetTop = current.inset * scale;
                const project = value => value && Object.fromEntries(Object.entries(value).map(([key, value]) => [key, value * scale]));
                const update = {token: current.token, display: current.display, controlInsetTop,
                    controlBounds: project(current.controlBounds), safeAreaInsets: project(current.safeAreaInsets)};
                const key = JSON.stringify(update);
                if (current.projectedKey === key) return;
                current.projectedKey = key;
                current.projectedInset = controlInsetTop;
                window.__breadPresentationUpdate(update);
            };
            addEventListener('resize', window.__breadReprojectMetrics);
            if (window.visualViewport) visualViewport.addEventListener('resize', window.__breadReprojectMetrics);
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
        let frame = button.convert(button.bounds, to: webView)
        let safe = owner?.view.safeAreaInsets ?? .zero
        let controlBounds: [String: CGFloat]? = state.display == .fullscreen ?
            ["left": max(0, frame.minX), "top": max(0, frame.minY), "width": frame.width, "height": frame.height] : nil
        let safeAreaInsets: [String: CGFloat]? = state.display == .fullscreen ?
            ["top": safe.top, "left": safe.left, "right": safe.right, "bottom": safe.bottom] : nil
        let key = "\(token):\(layoutRevision):\(state.display.rawValue):\(inset):\(webView.bounds.width):\(frame):\(safe)"
        if key != lastMetricKey {
            lastMetricKey = key
            metricRevision += 1
        }
        return ["token": token, "revision": metricRevision, "display": state.display.rawValue,
                "inset": inset, "width": webView.bounds.width, "fence": false,
                "controlBounds": controlBounds.map { $0 as Any } ?? NSNull(), "safeAreaInsets": safeAreaInsets.map { $0 as Any } ?? NSNull()]
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
        proxy.isHidden = true
        proxy.isUserInteractionEnabled = false
        proxy.accessibilityElementsHidden = true
        proxy.contentMode = .scaleToFill
        proxy.layer.minificationFilter = .trilinear
        view.insertSubview(proxy, belowSubview: cover)
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
        button.accessibilityIdentifier = "bread-presentation-minimize"
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
        button.addTarget(self, action: #selector(minimizeTapped), for: .touchUpInside)
        view.addSubview(button)
        render()
    }

    private func layoutControls() {
        guard let view = owner?.view else { return }
        cover.frame = view.bounds
        proxy.frame = webView?.frame ?? view.bounds
        let safe = view.safeAreaInsets
        button.frame = CGRect(x: safe.left + 12, y: safe.top + 8, width: 64, height: 48)
        capsuleBackground.frame = button.frame

    }

    @objc private func retry() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        beginNavigation()
        owner?.reload()
    }

    @objc private func minimizeTapped() {
        guard state.effectiveVisibility, let owner, owner.managedClose?.closing != true else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        var data: [String: Any] = ["id": owner.instanceId ?? "", "policyRevision": state.policyRevision,
            "visibilitySequence": state.acknowledgedVisibilitySequence]
        if let lifetime = owner.managedClose?.token { data["managedHostCloseToken"] = lifetime }
        owner.capBrowserPlugin?.notifyListeners("presentationMinimizeRequested", data: data)
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
