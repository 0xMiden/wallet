from pathlib import Path

boundary = Path("replay/src/app/ErrorBoundary.tsx")
s = boundary.read_text()
needle = "  static getDerivedStateFromError(error: Error) {\n"
insert = """  static getDerivedStateFromError(error: Error) {
    const className = ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'Error'].includes(error.name)
      ? error.name : 'other';
    const source = error.message === 'No account selected' ? 'no-account' :
      error.message === 'Settings not loaded' ? 'settings-not-loaded' :
      error.message === 'useDappBrowser must be used inside <DappBrowserProvider>' ? 'missing-dapp-provider' :
      /^Minified React error #\\d+/.test(error.message) ? 'react-minified' : 'other';
    Object.assign(window, { __BOOT_DIAGNOSTIC__: { className, source, phase: Reflect.get(window, '__INJECTION_PHASE__') === true ? 'after' : 'before' } });
"""
assert s.count(needle) == 1
boundary.write_text(s.replace(needle, insert))
proof = Path("replay/playwright/proofs/recovery-native-ui/readiness.spec.ts")
s = proof.read_text()
needle = "bodyNonempty:!!document.body.textContent.trim()}"
assert s.count(needle) == 1
s = s.replace(needle, "bodyNonempty:!!document.body.textContent.trim(),bootDiagnostic:window.__BOOT_DIAGNOSTIC__ || null}")
needle = "      window.__TEST_STORE__.setState({status:2,"
assert s.count(needle) == 1
s = s.replace(needle, "      window.__INJECTION_PHASE__ = true; window.__TEST_STORE__.setState({status:2,")
proof.write_text(s)
