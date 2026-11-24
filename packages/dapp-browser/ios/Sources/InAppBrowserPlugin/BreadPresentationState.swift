import Foundation

final class BreadPresentationState {
    enum Display: String { case browser, fullscreen }
    enum Phase { case preparing, visible, temporarilyHidden, error, closed }
    enum Motion { case none, expanding, collapsing }
    private(set) var generation = 0
    private(set) var display: Display = .browser
    private(set) var desiredVisibility = true
    private(set) var foreground = true
    private(set) var documentReady = false
    private(set) var remaining: TimeInterval
    private(set) var policyRevision = 0
    private var acknowledgedPolicy: Int?
    private var visibilitySequence = 0
    private(set) var acknowledgedVisibilitySequence = 0
    private(set) var motion = Motion.none
    private var proxyGeneration: Int?
    var proxyUsable: Bool { !closed && proxyGeneration == generation }
    var policyResolved: Bool { configured || failed }
    var effectiveVisibility: Bool { desiredVisibility && foreground && policyResolved && acknowledgedPolicy == policyRevision && !closed }
    // Keep the privacy-covered game authoritative for the system snapshot until its host revokes ownership.
    var surfaceVisibility: Bool {
        effectiveVisibility || (desiredVisibility && display == .fullscreen && configured
            && documentReady && revealed && !failed && !closed && acknowledgedPolicy == policyRevision)
    }
    private var configured = false
    private var painted = false
    private var failed = false
    private var revealed = false
    private var closed = false
    private let timeout: TimeInterval

    init(timeout: TimeInterval, initiallyVisible: Bool = true) {
        self.timeout = timeout; remaining = timeout; desiredVisibility = initiallyVisible
    }
    var phase: Phase {
        if closed { return .closed }
        if !desiredVisibility || !foreground { return .temporarilyHidden }
        if failed { return .error }
        return configured && documentReady && painted ? .visible : .preparing
    }

    @discardableResult func beginNavigation() -> Int {
        guard !closed else { return generation }
        generation += 1
        policyRevision += 1
        acknowledgedPolicy = nil
        configured = false
        documentReady = false
        painted = false
        failed = false
        revealed = false
        remaining = timeout
        return generation
    }

    @discardableResult func configure(_ display: Display, generation: Int) -> Bool {
        guard accepts(generation), !failed else { return false }
        if !configured || self.display != display {
            policyRevision += 1
            acknowledgedPolicy = nil
        }
        if self.display != display { painted = false }
        self.display = display
        configured = true
        return true
    }

    @discardableResult func ready(generation: Int) -> Bool {
        guard accepts(generation), configured, !failed else { return false }
        documentReady = true
        return true
    }

    func layoutPrepared(generation: Int) {
        guard accepts(generation), !failed else { return }
        painted = true
        if phase == .visible && effectiveVisibility { revealed = true }
    }

    func invalidateLayout() { if !closed { painted = false } }

    @discardableResult func requestVisibility(_ visible: Bool, policyRevision: Int? = nil, sequence: Int? = nil) -> Bool {
        guard !closed else { return false }
        if let sequence {
            guard sequence > visibilitySequence else { return false }
            visibilitySequence = sequence
        }
        if visible, let policyRevision {
            guard policyResolved, policyRevision == self.policyRevision else { return false }
            acknowledgedPolicy = policyRevision
        }
        if let sequence { acknowledgedVisibilitySequence = sequence }
        desiredVisibility = visible
        if !visible { motion = .none }
        return true
    }

    func setForeground(_ foreground: Bool) {
        guard !closed else { return }
        self.foreground = foreground
    }

    func elapse(_ seconds: TimeInterval) {
        guard !revealed, phase == .preparing, seconds.isFinite, seconds > 0 else { return }
        remaining = max(0, remaining - seconds)
        if remaining == 0 { fail(generation: generation) }
    }

    func fail(generation: Int) {
        if accepts(generation), !failed {
            if !policyResolved { policyRevision += 1; acknowledgedPolicy = nil }
            failed = true
        }
    }

    @discardableResult func beginMotion(_ motion: Motion) -> Bool {
        guard !closed, motion != Motion.none else { return false }
        self.motion = motion
        return true
    }

    func endMotion() { motion = .none }

    func captureProxy() { if !closed { proxyGeneration = generation } }

    func dropProxy() { proxyGeneration = nil }

    @discardableResult func close() -> Bool {
        guard !closed else { return false }
        closed = true
        motion = .none
        return true
    }

    private func accepts(_ generation: Int) -> Bool { !closed && self.generation == generation }

    // Evaluation crosses a navigation boundary; both the document and generation must survive it.
    static func acceptsMessage(mainFrame: Bool, messageToken: String, documentToken: String?,
                               startedGeneration: Int, currentGeneration: Int) -> Bool {
        mainFrame && !messageToken.isEmpty && messageToken == documentToken && startedGeneration == currentGeneration
    }
}

enum BreadCapsuleDrag {
    static let commitTravel = 0.3
    static let projectionSeconds = 0.3
    static let flingVelocity = 450.0
    static let maximumProgressVelocity = 8.0

    static func shouldBegin(horizontalVelocity: Double, verticalVelocity: Double) -> Bool {
        horizontalVelocity.isFinite && verticalVelocity.isFinite
            && verticalVelocity > 0 && verticalVelocity > abs(horizontalVelocity)
    }

    static func progress(translationY: Double, distance: Double) -> Double {
        guard translationY.isFinite, distance.isFinite, distance > 0 else { return 1 }
        let value = 1 - translationY / distance
        if value > 1 { return 1 + BreadMorphGeometry.rubberBand((value - 1) * distance, length: distance) / distance }
        if value < 0 { return BreadMorphGeometry.rubberBand(value * distance, length: distance) / distance }
        return value
    }

    static func progressVelocity(verticalVelocity: Double, distance: Double) -> Double {
        guard verticalVelocity.isFinite, distance.isFinite, distance > 0 else { return 0 }
        return min(maximumProgressVelocity, max(-maximumProgressVelocity, -verticalVelocity / distance))
    }

    static func releaseTarget(progress: Double, progressVelocity: Double, verticalVelocity: Double) -> Double {
        let projected = progress + projectionSeconds * progressVelocity - 1
        if abs(verticalVelocity) >= flingVelocity && abs(progressVelocity) > 0.01 {
            return progressVelocity > 0 ? 1 : 0
        }
        if abs(projected) >= commitTravel { return projected > 0 ? 1 : 0 }
        return 1
    }
}
