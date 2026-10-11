import Foundation

final class BreadPresentationState {
    enum Display: String { case browser, fullscreen }
    enum Phase { case preparing, visible, temporarilyHidden, error, closed }
    private(set) var generation = 0
    private(set) var display: Display = .browser
    private(set) var desiredVisibility = true
    private(set) var foreground = true
    private(set) var documentReady = false
    private(set) var remaining: TimeInterval
    private var configured = false
    private var painted = false
    private var failed = false
    private var revealed = false
    private var closed = false
    private let timeout: TimeInterval

    init(timeout: TimeInterval) { self.timeout = timeout; remaining = timeout }
    var phase: Phase {
        if closed { return .closed }
        if !desiredVisibility || !foreground { return .temporarilyHidden }
        if failed { return .error }
        return configured && documentReady && painted ? .visible : .preparing
    }

    @discardableResult func beginNavigation() -> Int {
        guard !closed else { return generation }
        generation += 1
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
        if phase == .visible { revealed = true }
    }

    func invalidateLayout() { if !closed { painted = false } }

    @discardableResult func requestVisibility(_ visible: Bool) -> Bool {
        guard !closed else { return false }
        desiredVisibility = visible
        return true
    }

    func setForeground(_ foreground: Bool) {
        guard !closed else { return }
        self.foreground = foreground
    }

    func elapse(_ seconds: TimeInterval) {
        guard !revealed, phase == .preparing, seconds.isFinite, seconds > 0 else { return }
        remaining = max(0, remaining - seconds)
        if remaining == 0 { failed = true }
    }

    func fail(generation: Int) {
        if accepts(generation) { failed = true }
    }

    @discardableResult func close() -> Bool {
        guard !closed else { return false }
        closed = true
        return true
    }

    private func accepts(_ generation: Int) -> Bool { !closed && self.generation == generation }

    // Evaluation crosses a navigation boundary; both the document and generation must survive it.
    static func acceptsMessage(mainFrame: Bool, messageToken: String, documentToken: String?,
                               startedGeneration: Int, currentGeneration: Int) -> Bool {
        mainFrame && !messageToken.isEmpty && messageToken == documentToken && startedGeneration == currentGeneration
    }
}
