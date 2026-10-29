const CLASSES = ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'];

// This only validates inventory evidence. A separate ownership and external-binding check is required before cleanup.
export function validateTopologyNamespaces(pages, expected) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100 ||
      !expected || typeof expected.script !== 'string' || !/^miden-elig-topology-[1-9][0-9]{0,17}-[1-9][0-9]{0,5}$/.test(expected.script) ||
      !Array.isArray(expected.classes) || expected.classes.length !== CLASSES.length ||
      new Set(expected.classes).size !== CLASSES.length || !CLASSES.every(name => expected.classes.includes(name))) return false;
  const ids = new Set();
  const found = new Set();
  let total = 0;
  let expectedTotal;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const info = page?.result_info;
    if (page?.success !== true || !Array.isArray(page.errors) || page.errors.length || !Array.isArray(page.result) ||
        !info || info.page !== index + 1 || info.per_page !== 1000 || info.total_pages !== pages.length ||
        info.count !== page.result.length || !Number.isSafeInteger(info.total_count) || info.total_count < 0 ||
        (expectedTotal !== undefined && expectedTotal !== info.total_count)) return false;
    expectedTotal = info.total_count;
    total += page.result.length;
    for (const entry of page.result) {
      if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9]{32}$/.test(entry.id) || ids.has(entry.id) ||
          typeof entry.class !== 'string' || !entry.class || typeof entry.script !== 'string' || !entry.script ||
          typeof entry.use_sqlite !== 'boolean') return false;
      ids.add(entry.id);
      if (entry.script !== expected.script) continue;
      if (entry.use_sqlite !== true || !CLASSES.includes(entry.class) || found.has(entry.class)) return false;
      found.add(entry.class);
    }
  }
  return total === expectedTotal && found.size === CLASSES.length;
}
