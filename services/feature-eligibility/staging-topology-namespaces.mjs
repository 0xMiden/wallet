const CLASSES = ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'];

// This only validates inventory evidence. A separate ownership and external-binding check is required before cleanup.
export function validateTopologyNamespaces(pages, expected) {
  if (
    !Array.isArray(pages) ||
    pages.length < 1 ||
    pages.length > 100 ||
    !expected ||
    typeof expected.script !== 'string' ||
    !/^miden-elig-topology-[1-9][0-9]{0,17}-[1-9][0-9]{0,5}$/.test(expected.script) ||
    !Array.isArray(expected.classes) ||
    expected.classes.length !== CLASSES.length ||
    new Set(expected.classes).size !== CLASSES.length ||
    !CLASSES.every(name => expected.classes.includes(name))
  )
    return false;
  const ids = new Set();
  const found = new Set();
  let total = 0;
  let expectedTotal;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const info = page?.result_info;
    if (
      page?.success !== true ||
      !Array.isArray(page.errors) ||
      page.errors.length ||
      !Array.isArray(page.result) ||
      !info ||
      info.page !== index + 1 ||
      info.per_page !== 1000 ||
      info.total_pages !== pages.length ||
      info.count !== page.result.length ||
      !Number.isSafeInteger(info.total_count) ||
      info.total_count < 0 ||
      info.total_pages !== Math.max(1, Math.ceil(info.total_count / 1000)) ||
      info.count !== Math.min(1000, info.total_count - index * 1000) ||
      (expectedTotal !== undefined && expectedTotal !== info.total_count)
    )
      return false;
    expectedTotal = info.total_count;
    total += page.result.length;
    for (const entry of page.result) {
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(entry.id) ||
        ids.has(entry.id) ||
        typeof entry.class !== 'string' ||
        !entry.class ||
        typeof entry.script !== 'string' ||
        !entry.script ||
        typeof entry.use_sqlite !== 'boolean'
      )
        return false;
      ids.add(entry.id);
      if (entry.script !== expected.script) continue;
      if (entry.use_sqlite !== true || !CLASSES.includes(entry.class) || found.has(entry.class)) return false;
      found.add(entry.class);
    }
  }
  return total === expectedTotal && found.size === CLASSES.length;
}

// The caller must independently establish the complete script list before using this evidence.
export function validateTopologyBindings(scripts, expected) {
  if (
    !Array.isArray(scripts) ||
    !expected ||
    typeof expected.script !== 'string' ||
    !/^miden-elig-topology-[1-9][0-9]{0,17}-[1-9][0-9]{0,5}$/.test(expected.script) ||
    !Array.isArray(expected.scripts) ||
    !Array.isArray(expected.namespaceIds) ||
    expected.scripts.length !== scripts.length ||
    expected.scripts.length < 1 ||
    new Set(expected.scripts).size !== expected.scripts.length ||
    !expected.scripts.includes(expected.script) ||
    expected.namespaceIds.length < 1 ||
    new Set(expected.namespaceIds).size !== expected.namespaceIds.length ||
    !expected.namespaceIds.every(id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id))
  )
    return false;
  const seenScripts = new Set();
  const seenOwned = new Set();
  const owned = new Set(expected.namespaceIds);
  for (const script of scripts) {
    if (
      !script ||
      typeof script.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,63}$/.test(script.id) ||
      !expected.scripts.includes(script.id) ||
      seenScripts.has(script.id) ||
      !Array.isArray(script.bindings)
    )
      return false;
    seenScripts.add(script.id);
    for (const entry of script.bindings) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || typeof entry.type !== 'string' || !entry.type)
        return false;
      if (entry.type === 'service') {
        if (typeof entry.service !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(entry.service)) return false;
        if (script.id !== expected.script && entry.service === expected.script) return false;
        continue;
      }
      if (entry.type !== 'durable_object_namespace') continue;
      if (
        typeof entry.class_name !== 'string' ||
        !entry.class_name ||
        typeof entry.namespace_id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(entry.namespace_id) ||
        (entry.script_name !== undefined && (typeof entry.script_name !== 'string' || !entry.script_name))
      )
        return false;
      const targetBinding = owned.has(entry.namespace_id) || entry.script_name === expected.script;
      if (script.id !== expected.script && targetBinding) return false;
      if (script.id === expected.script) {
        if (!owned.has(entry.namespace_id) || seenOwned.has(entry.namespace_id)) return false;
        if (entry.script_name !== undefined && entry.script_name !== expected.script) return false;
        seenOwned.add(entry.namespace_id);
      }
    }
  }
  return seenScripts.size === expected.scripts.length && seenOwned.size === owned.size;
}

// The returned list is evidence only; settings and namespace ownership must still be checked independently.
export function readTopologyScriptInventory(pages) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100) return null;
  const ids = [];
  const seen = new Set();
  let total;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const info = page?.result_info;
    if (
      page?.success !== true ||
      !Array.isArray(page.errors) ||
      page.errors.length ||
      !Array.isArray(page.result) ||
      !info ||
      info.page !== index + 1 ||
      info.per_page !== 100 ||
      info.total_pages !== pages.length ||
      info.count !== page.result.length ||
      !Number.isSafeInteger(info.total_count) ||
      info.total_count < 0 ||
      info.total_pages !== Math.max(1, Math.ceil(info.total_count / 100)) ||
      info.count !== Math.min(100, info.total_count - index * 100) ||
      (total !== undefined && total !== info.total_count)
    )
      return null;
    total = info.total_count;
    for (const entry of page.result) {
      if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(entry.id) || seen.has(entry.id))
        return null;
      seen.add(entry.id);
      ids.push(entry.id);
    }
  }
  return ids.length === total ? ids : null;
}

export async function collectTopologyScriptInventory(api) {
  try {
    const scan = async () => {
      const pages = [];
      let totalPages = 1;
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
        const response = await api(`/workers/scripts?page=${pageNumber}&per_page=100`);
        if (pageNumber === 1) {
          totalPages = response?.result_info?.total_pages;
          if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > 100) return null;
        }
        pages.push(response);
      }
      return readTopologyScriptInventory(pages);
    };
    const first = await scan();
    if (first === null) return null;
    const second = await scan();
    return second !== null && first.length === second.length && first.every((id, index) => id === second[index])
      ? first
      : null;
  } catch {
    return null;
  }
}
