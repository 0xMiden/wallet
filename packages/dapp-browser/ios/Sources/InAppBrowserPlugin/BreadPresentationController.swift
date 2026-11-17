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
    static var snapshotHook: ((WKSnapshotConfiguration) -> Void)?
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
    private var crossfade: DispatchWorkItem?
    private var proxyCapture = 0
    private var capturing = false
    private var snapshotWaiters: [(UIImage?) -> Void] = []
    private var preparedProxy: (generation: Int, layout: Int, at: CFTimeInterval)?
    private var systemUIHeld: Bool?
    private var grab: (start: Double, target: Double, raw: Double)?

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
                self.finishMotion()
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
    // Status bar and home indicator keep what the host showed when a motion began and take their end state as it settles.
    var hidesSystemUI: Bool { systemUIHeld ?? immersive }
    private var moving: Bool { state.motion != .none }
    private var heading: BreadMorphTarget { state.motion == .collapsing ? .collapsed : .expanded }
    private var proxyAvailable: Bool { state.proxyUsable && state.foreground && proxy.image != nil }

    func preparePrivacyCover() -> Bool {
        guard owner?.managedClose?.closing != true else { return false }
        if finishMotion() { render() }
        guard let window = instance?.containerWindow, !window.isHidden, window.isKeyWindow else { return false }
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
            container.onTap = { [weak self] in self?.handleTap() }
            container.onPan = { [weak self] phase, translation, velocity in
                self?.handleGrab(phase, translation: translation, velocity: velocity)
            }
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
        let wasHeading: BreadMorphTarget? = moving ? heading : nil
        let progress = animator?.progress() ?? 0
        let velocity = animator?.velocity() ?? 0
        guard state.requestVisibility(visible, policyRevision: policyRevision, sequence: sequence) else { return }
        guard let wasHeading, !moving else {
            if state.effectiveVisibility != wasVisible { invalidateLayout() }
            render()
            return
        }
        let cancelled = morphId
        stopMorph()
        // Hide before the rest pose returns, in one transaction, so the full page never shows for a frame.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if state.effectiveVisibility != wasVisible { invalidateLayout() }
        render()
        animator?.reset()
        CATransaction.commit()
        if let cancelled { emit(.cancelled, id: cancelled, target: wasHeading, progress: progress, velocity: velocity) }
        if wasHeading == .collapsed { UIAccessibility.post(notification: .screenChanged, argument: nil) }
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

    /// An expand's first frame would carry the whole unhide, the render server building the window's layer tree
    /// under the morph. A touch-down on the page's card shows the window at zero alpha instead, so that work
    /// lands before the morph starts; the morph then only starts moving it. It lapses with the frame-rate request.
    private(set) var warmed = false
    private var warmCooldown: DispatchWorkItem?

    private func warmWindow() {
        guard !moving, state.phase == .visible || state.phase == .temporarilyHidden, !state.surfaceVisibility,
              owner?.managedClose?.closing != true, let window = instance?.containerWindow else { return }
        if warmed && !window.isHidden {
            scheduleWarmCooldown()
            return
        }
        guard window.isHidden else { return }
        if applySlotFrame(window) { window.layoutIfNeeded() }
        warmed = true
        applyWarmth(to: window)
        scheduleWarmCooldown()
    }

    private func scheduleWarmCooldown() {
        warmCooldown?.cancel()
        warmCooldown = nil
        let work = DispatchWorkItem { [weak self] in self?.coolWindow() }
        warmCooldown = work
        DispatchQueue.main.asyncAfter(deadline: .now() + BreadFrameRateBoost.duration + 0.15, execute: work)
    }

    private func coolWindow() {
        warmCooldown = nil
        guard warmed, !moving, !state.surfaceVisibility, let window = instance?.containerWindow else { return }
        warmed = false
        applyWarmth(to: window)
    }

    /// Hidden, warm (shown, unseen and untouchable) or shown, from `warmed` and the surface visibility.
    private func applyWarmth(to window: UIWindow) {
        let unseen = warmed && !state.surfaceVisibility
        window.isHidden = !state.surfaceVisibility && !warmed
        window.alpha = unseen ? 0 : 1
        window.isUserInteractionEnabled = !unseen
        window.accessibilityElementsHidden = unseen
    }

    func prepareMorph(warm: Bool = false) {
        if warm { warmWindow() }
        guard !moving, !capturing, !proxyPrepared, showsLivePage else { return }
        captureProxy(prepared: true)
    }

    private var proxyPrepared: Bool {
        guard proxyFresh, let prepared = preparedProxy else { return false }
        return prepared.generation == state.generation && prepared.layout == layoutRevision
            && CACurrentMediaTime() - prepared.at <= BreadFrameRateBoost.duration
    }

    func dropProxy() {
        proxy.image = nil
        proxyFresh = false
        state.dropProxy()
        if proxyCovering { cancelReveal() }
    }

    func snapshotFromProxy(_ deliver: @escaping (UIImage?) -> Void) -> Bool {
        if capturing {
            snapshotWaiters.append(deliver)
            return true
        }
        // A shown page is captured whole, so the park this snapshot precedes leaves a proxy for the next expand.
        if !moving, showsLivePage {
            snapshotWaiters.append(deliver)
            captureProxy()
            return true
        }
        guard proxyFresh, state.proxyUsable, let image = proxy.image else { return false }
        deliver(image)
        return true
    }

    private var showsLivePage: Bool {
        state.phase == .visible && (cover.isHidden || revealAnimator != nil) && instance?.containerWindow?.isHidden == false && !warmed
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
        let systemUI = hidesSystemUI
        if target == .expanded {
            guard state.requestVisibility(true, policyRevision: policyRevision, sequence: sequence) else { return false }
            guard state.surfaceVisibility else {
                if state.effectiveVisibility != wasVisible { invalidateLayout() }
                render()
                return false
            }
        } else {
            guard wasMoving || (wasVisible && !window.isHidden),
                  state.requestVisibility(true, sequence: sequence) else { return false }
        }
        let previous = morphId
        let fromRest = target == .expanded && !wasMoving && (window.isHidden || warmed)
        if !wasMoving, applySlotFrame(window) { window.layoutIfNeeded() }
        // The shown pose is drawn against the card the motion started with; a new one would make the next interrupt jump.
        let landing = wasMoving ? animator.card : card.flatMap { fits($0, in: window.bounds.size) ? $0 : nil }
        let progressVelocity = previous != nil ? animator.velocity()
            : landing.map { BreadMorphGeometry.progressVelocity(velocity, card: $0.rect, slot: window.bounds) } ?? 0
        if !wasMoving { systemUIHeld = systemUI }
        state.beginMotion(target == .expanded ? .expanding : .collapsing)
        morphSequence = sequence ?? state.acknowledgedVisibilitySequence
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if fromRest { animator.hold(0, card: landing) }
        if target == .expanded { beginExpandVisuals(fromRest: fromRest) }
        if state.effectiveVisibility != wasVisible { invalidateLayout() }
        render()
        CATransaction.commit()
        if target == .collapsed { beginCollapseVisuals() }
        morphId = id
        run(to: target, card: landing, velocity: progressVelocity, physics: target == .expanded ? .expand : .collapse)
        if previous != nil {
            emitRetarget(id, target: target)
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
        scheduleCrossfade()
    }

    private func beginCollapseVisuals() {
        crossfade?.cancel()
        crossfade = nil
        proxyFade?.stopAnimation(true)
        proxyFade = nil
        webView?.endEditing(true)
        webView?.isUserInteractionEnabled = false
        guard !proxyCovering else { return }
        proxy.alpha = 0
        proxy.isHidden = false
        if showsLivePage, !proxyPrepared { captureProxy() }
        preparedProxy = nil
    }

    private func captureProxy(prepared: Bool = false) {
        guard let webView else { return }
        let generation = state.generation
        let layout = layoutRevision
        let started = CACurrentMediaTime()
        proxyCapture += 1
        let serial = proxyCapture
        capturing = true
        proxyFresh = false
        preparedProxy = nil
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = false
        Self.snapshotHook?(configuration)
        webView.takeSnapshot(with: configuration) { [weak self] image, _ in
            guard let self, self.proxyCapture == serial else { return }
            self.capturing = false
            let waiters = self.snapshotWaiters
            self.snapshotWaiters = []
            guard let image, self.state.generation == generation, self.state.phase != .closed else {
                waiters.forEach { $0(nil) }
                return
            }
            self.adoptProxy(image)
            if prepared, self.layoutRevision == layout { self.preparedProxy = (generation, layout, started) }
            if self.state.motion == .collapsing, (self.animator?.progress() ?? 1) <= 0.35 { self.fadeInProxy() }
            waiters.forEach { $0(image) }
        }
    }

    private func scheduleCrossfade() {
        crossfade?.cancel()
        crossfade = nil
        guard state.motion == .collapsing, let animator, let spring = animator.spring else { return }
        let now = animator.now()
        guard let at = spring.time(reaching: 0.35), at > now else {
            if animator.progress() <= 0.35 { fadeInProxy() }
            return
        }
        let work = DispatchWorkItem { [weak self] in self?.fadeInProxy() }
        crossfade = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (at - now), execute: work)
    }

    private func fadeInProxy() {
        crossfade = nil
        guard state.motion == .collapsing, proxyFresh, proxyAvailable, !proxyCovering,
              proxy.isHidden || proxy.alpha < 1, !UIAccessibility.isReduceMotionEnabled else { return }
        proxy.isHidden = false
        fadeProxy(to: 1, duration: 0.1)
    }

    private func stopMorph() {
        systemUIHeld = nil
        morphId = nil
        grab = nil
        crossfade?.cancel()
        crossfade = nil
        proxyFade?.stopAnimation(true)
        proxyFade = nil
        if owner?.managedClose?.closing != true { webView?.isUserInteractionEnabled = true }
    }

    @discardableResult private func finishMotion() -> Bool {
        guard morphId != nil, let animator else { return false }
        let end = animator.finish()
        return completeMotion(at: end >= 0.5 ? .expanded : .collapsed)
    }

    func managedCloseStarted() {
        guard morphId != nil, let animator else { return }
        if animator.finish() >= 0.5 { state.endMotion() }
        stopMorph()
    }

    private func beginExpandVisuals(fromRest: Bool) {
        webView?.isUserInteractionEnabled = false
        proxyFresh = false
        if fromRest {
            proxyFade?.stopAnimation(true)
            proxyFade = nil
            if let image = proxy.image, let webView,
               abs(image.size.width - webView.bounds.width) >= 1 || abs(image.size.height - webView.bounds.height) >= 1 {
                dropProxy()
            }
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
        systemUIHeld = nil
        morphId = nil
        grab = nil
        crossfade?.cancel()
        crossfade = nil
        if end == .expanded {
            state.endMotion()
            webView?.isUserInteractionEnabled = true
            if !proxyCovering, proxyFade == nil { proxy.isHidden = true }
        } else if proxyFresh, proxyAvailable, !proxyCovering, !UIAccessibility.isReduceMotionEnabled {
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

    func handleTap() {
        guard let id = morphId, let animator, grab == nil else { return }
        let target: BreadMorphTarget = heading == .collapsed ? .expanded : .collapsed
        retarget(id, to: target, velocity: animator.velocity(), physics: target == .expanded ? .expand : .collapse)
    }

    func handleGrab(_ phase: UIGestureRecognizer.State, translation: CGPoint, velocity: CGPoint) {
        guard let id = morphId, let animator, !UIAccessibility.isReduceMotionEnabled else { return }
        let path = morphPath()
        let length = Double(hypot(path.x, path.y))
        switch phase {
        case .began:
            crossfade?.cancel()
            crossfade = nil
            let start = animator.freeze()
            grab = (start: start, target: heading == .expanded ? 1 : 0, raw: start)
            emit(.retargeted, id: id, target: heading, progress: start, velocity: 0, tracking: true)
        case .changed:
            guard var current = grab, length > 0 else { return }
            current.raw = current.start + Double(translation.x * path.x + translation.y * path.y) / (length * length)
            grab = current
            animator.track(banded(current.raw, length: length))
        case .ended, .cancelled, .failed:
            guard let current = grab else { return }
            grab = nil
            let along = length > 0 ? Double(velocity.x * path.x + velocity.y * path.y) / length : 0
            let progressVelocity = length > 0 ? min(8, max(-8, along / length)) : 0
            let travel = current.raw + 0.3 * progressVelocity - current.start
            let end: Double
            if abs(travel) >= 0.3 { end = travel > 0 ? 1 : 0 } else if abs(along) >= 450 { end = along > 0 ? 1 : 0 } else { end = current.target }
            retarget(id, to: end == 1 ? .expanded : .collapsed, velocity: progressVelocity, physics: .release)
        default:
            break
        }
    }

    private func retarget(_ id: String, to target: BreadMorphTarget, velocity: Double, physics: BreadMorphPhysics) {
        guard let animator else { return }
        let turned = heading != target
        state.beginMotion(target == .expanded ? .expanding : .collapsing)
        if turned {
            if target == .expanded { beginExpandVisuals(fromRest: false) } else { beginCollapseVisuals() }
        }
        run(to: target, card: animator.card, velocity: velocity, physics: physics)
        emitRetarget(id, target: target)
    }

    private func emitRetarget(_ id: String, target: BreadMorphTarget) {
        guard let animator else { return }
        let start = animator.spring.map { (progress: $0.from, velocity: $0.velocity) }
        emit(.retargeted, id: id, target: target, progress: start?.progress ?? animator.progress(),
             velocity: start?.velocity ?? animator.velocity())
    }

    private func morphPath() -> CGPoint {
        guard let bounds = instance?.morphContainer?.view.bounds else { return .zero }
        guard let card = animator?.card?.rect else { return CGPoint(x: 0, y: -bounds.height / 2) }
        return CGPoint(x: bounds.midX - card.midX, y: bounds.midY - card.midY)
    }

    private func banded(_ p: Double, length: Double) -> Double {
        if p > 1 { return 1 + BreadMorphGeometry.rubberBand((p - 1) * length, length: length) / length }
        if p < 0 { return BreadMorphGeometry.rubberBand(p * length, length: length) / length }
        return p
    }

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
        finishMotion()
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

    /// True while the first responder is inside the dApp web view (WebKit's content view holds it
    /// for a focused field, not the `WKWebView` itself).
    private var webViewIsEditing: Bool {
        guard let webView else { return false }
        return Self.containsFirstResponder(webView)
    }

    private static func containsFirstResponder(_ view: UIView) -> Bool {
        if view.isFirstResponder { return true }
        return view.subviews.contains { containsFirstResponder($0) }
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
            if state.surfaceVisibility { warmed = false }
            applyWarmth(to: window)
            if systemUIHeld == nil {
                if immersive { window.makeKey() }
                // The dApp window becomes key when a field in its web view takes focus. A render that
                // lands then (a slot re-fit, a policy publish) must not hand key status back to the
                // host: that resigns the field and dismisses the keyboard the dApp has just raised.
                else if window.isKeyWindow, !webViewIsEditing { hostWindow?.makeKey() }
            }
        }
        if systemUIHeld == nil {
            owner.setNeedsStatusBarAppearanceUpdate()
            owner.setNeedsUpdateOfHomeIndicatorAutoHidden()
            owner.navigationController?.setNeedsStatusBarAppearanceUpdate()
            owner.navigationController?.setNeedsUpdateOfHomeIndicatorAutoHidden()
            instance?.morphContainer?.setNeedsStatusBarAppearanceUpdate()
            instance?.morphContainer?.setNeedsUpdateOfHomeIndicatorAutoHidden()
            hostWindow?.rootViewController?.setNeedsStatusBarAppearanceUpdate()
        }
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
        finishMotion()
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
                // Only the wait for the screen update fences the paint; one point keeps the render server's copy free.
                let configuration = WKSnapshotConfiguration()
                configuration.afterScreenUpdates = true
                configuration.rect = CGRect(x: 0, y: 0, width: 1, height: 1)
                configuration.snapshotWidth = 1
                Self.snapshotHook?(configuration)
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
        button.addTarget(self, action: #selector(capsuleTouchDown), for: .touchDown)
        button.addTarget(self, action: #selector(capsuleTouchEnded), for: [.touchCancel, .touchUpOutside])
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

    @objc private func capsuleTouchDown() {
        BreadFrameRateBoost.shared.hold()
        prepareMorph()
    }

    @objc private func capsuleTouchEnded() { BreadFrameRateBoost.shared.release() }

    @objc private func minimizeTapped() {
        guard state.effectiveVisibility, let owner, owner.managedClose?.closing != true else {
            capsuleTouchEnded()
            return
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        var data: [String: Any] = ["id": owner.instanceId ?? "", "policyRevision": state.policyRevision,
            "visibilitySequence": state.acknowledgedVisibilitySequence]
        if !moving, let window = instance?.containerWindow {
            let id = "native-" + UUID().uuidString
            let card = WebViewRegistry.shared.morphCard.map {
                BreadMorphCard(rect: $0.rect.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY), cornerRadius: $0.cornerRadius)
            }
            if morph(to: .collapsed, card: card, velocity: .zero, morphId: id, policyRevision: nil, sequence: nil) { data["morphId"] = id }
        }
        if let lifetime = owner.managedClose?.token { data["managedHostCloseToken"] = lifetime }
        owner.capBrowserPlugin?.notifyListeners("presentationMinimizeRequested", data: data)
    }

    func close() {
        guard state.close() else { return }
        stopMorph()
        animator?.reset()
        let waiters = snapshotWaiters
        snapshotWaiters = []
        waiters.forEach { $0(nil) }
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
