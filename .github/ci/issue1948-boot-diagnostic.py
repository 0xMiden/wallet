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

needle = "      window.__INJECTION_PHASE__ = true; window.__TEST_STORE__.setState({status:2,"
assert s.count(needle) == 1
s = s.replace(needle, "      window.__INJECTION_PHASE__ = true; window.__TEST_STORE__.setState({status:0,")
needle = "    const immediate = await observe();"
assert s.count(needle) == 1
s = s.replace(needle, """    await expect.poll(() => session.eval<boolean>("return !!document.querySelector('[data-testid=storage-recovery-page]');"), { timeout: 30_000 }).toBe(true);
    const unavailableIdle = await observe();
    await session.eval('window.__TEST_STORE__.setState({status:2}); return true;');
    const immediate = await observe();""")
needle = "JSON.stringify({ before, immediate, settled }, null, 2)"
assert s.count(needle) == 1
s = s.replace(needle, "JSON.stringify({ before, unavailableIdle, immediate, settled }, null, 2)")
proof.write_text(s)

needle = "    const immediate = await observe();"
assert s.count(needle) == 1
s = s.replace(needle, """    const immediate = await observe();
    await writeFile(join(output, 'pre-assertion.json'), JSON.stringify({ before, unavailableIdle, immediate }, null, 2));
    expect(immediate.recovery, 'Recovery remains visible with unavailable storage, Ready status, and no selected account').toBe(true);""")
proof.write_text(s)

needle = "bodyNonempty:!!document.body.textContent.trim(),bootDiagnostic:window.__BOOT_DIAGNOSTIC__ || null}"
assert s.count(needle) == 1
s = s.replace(needle, "bodyNonempty:!!document.body.textContent.trim(),accountPresent:!!s.currentAccount,bootDiagnostic:window.__BOOT_DIAGNOSTIC__ || null}")
needle = "    expect(immediate.recovery, 'Recovery remains visible"
assert s.count(needle) == 1
s = s.replace(needle, "    expect(unavailableIdle).toMatchObject({status:0, availability:'unavailable', accountPresent:false, recovery:true});\n    expect(immediate).toMatchObject({status:2, availability:'unavailable', accountPresent:false});\n    expect(immediate.recovery, 'Recovery remains visible")
proof.write_text(s)
