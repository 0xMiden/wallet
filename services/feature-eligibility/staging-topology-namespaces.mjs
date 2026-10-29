const CLASSES = ['TopologyControl', 'EligibilityGuard', 'CallerEligibilityGuard', 'RestartProof'];

// These records are observation evidence, not deployment or cleanup authorization.
export function readTopologyNamespaceInventory(pages) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100) return null;
  const ids = new Set();
  const records = [];
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
      return null;
    expectedTotal = info.total_count;
    total += page.result.length;
    for (const entry of page.result) {
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(entry.id) ||
        ids.has(entry.id) ||
        typeof entry.class !== 'string' ||
        !/^[a-zA-Z_$][a-zA-Z0-9_$]{0,127}$/.test(entry.class) ||
        typeof entry.script !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,63}$/.test(entry.script) ||
        typeof entry.use_sqlite !== 'boolean'
      )
        return null;
      ids.add(entry.id);
      records.push({ id: entry.id, className: entry.class, script: entry.script, use_sqlite: entry.use_sqlite });
    }
  }
  return total === expectedTotal ? records : null;
}

export function validateTopologyNamespaces(pages, expected) {
  if (
    !expected ||
    typeof expected.script !== 'string' ||
    !/^miden-elig-topology-[1-9][0-9]{0,17}-[1-9][0-9]{0,5}$/.test(expected.script) ||
    !Array.isArray(expected.classes) ||
    expected.classes.length !== CLASSES.length ||
    new Set(expected.classes).size !== CLASSES.length ||
    !CLASSES.every(name => expected.classes.includes(name))
  )
    return false;
  const records = readTopologyNamespaceInventory(pages);
  if (records === null) return false;
  const found = new Set();
  for (const record of records) {
    if (record.script !== expected.script) continue;
    if (record.use_sqlite !== true || !CLASSES.includes(record.className) || found.has(record.className)) return false;
    found.add(record.className);
  }
  return found.size === CLASSES.length;
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
    !expected.namespaceClasses ||
    typeof expected.namespaceClasses !== 'object' ||
    Array.isArray(expected.namespaceClasses) ||
    Object.keys(expected.namespaceClasses).length !== expected.namespaceIds.length ||
    !expected.namespaceIds.every(
      id => Object.hasOwn(expected.namespaceClasses, id) && CLASSES.includes(expected.namespaceClasses[id])
    ) ||
    new Set(Object.values(expected.namespaceClasses)).size !== expected.namespaceIds.length ||
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
        if (entry.class_name !== expected.namespaceClasses[entry.namespace_id]) return false;
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

export async function collectTopologyNamespaceRecords(api, expected) {
  try {
    const scan = async () => {
      const pages = [];
      let totalPages = 1;
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
        const response = await api(`/workers/durable_objects/namespaces?page=${pageNumber}&per_page=1000`);
        if (pageNumber === 1) {
          totalPages = response?.result_info?.total_pages;
          if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > 100) return null;
        }
        pages.push(response);
      }
      if (!validateTopologyNamespaces(pages, expected)) return null;
      return pages.flatMap(page =>
        page.result.map(({ id, class: className, script, use_sqlite }) => ({ id, className, script, use_sqlite }))
      );
    };
    const first = await scan();
    if (first === null) return null;
    const second = await scan();
    if (second === null || JSON.stringify(first) !== JSON.stringify(second)) return null;
    return first.filter(entry => entry.script === expected.script).map(({ id, className }) => ({ id, className }));
  } catch {
    return null;
  }
}

export async function collectTopologyNamespaces(api, expected) {
  const records = await collectTopologyNamespaceRecords(api, expected);
  return records === null ? null : records.map(entry => entry.id);
}

// Only closed binding metadata leaves this function; this is not an account or deployment ownership check.
export async function collectTopologySettings(api, ids) {
  try {
    if (
      !Array.isArray(ids) ||
      ids.length > 10000 ||
      new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(id))
    )
      return null;
    const scan = async () => {
      const scripts = [];
      for (const id of ids) {
        const response = await api(`/workers/scripts/${id}/settings`);
        if (
          response?.success !== true ||
          !Array.isArray(response.errors) ||
          response.errors.length ||
          !Array.isArray(response.result?.bindings)
        )
          return null;
        const names = new Set();
        const bindings = [];
        for (const entry of response.result.bindings) {
          if (
            !entry ||
            typeof entry.name !== 'string' ||
            !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(entry.name) ||
            names.has(entry.name) ||
            typeof entry.type !== 'string' ||
            !/^[a-z_]{1,64}$/.test(entry.type)
          )
            return null;
          names.add(entry.name);
          const binding = { name: entry.name, type: entry.type };
          const fields =
            entry.type === 'durable_object_namespace'
              ? ['class_name', 'namespace_id', 'script_name']
              : entry.type === 'service'
                ? ['service']
                : [];
          for (const field of fields) {
            if (entry[field] !== undefined) {
              if (typeof entry[field] !== 'string') return null;
              const pattern =
                field === 'namespace_id'
                  ? /^[a-f0-9]{32}$/
                  : field === 'class_name'
                    ? /^[a-zA-Z_$][a-zA-Z0-9_$]{0,127}$/
                    : /^[a-zA-Z0-9_-]{1,63}$/;
              if (!pattern.test(entry[field])) return null;
              binding[field] = entry[field];
            }
          }
          if (entry.type === 'ratelimit') {
            if (typeof entry.namespace_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(entry.namespace_id)) return null;
            binding.namespace_id = entry.namespace_id;
          }
          bindings.push(binding);
        }
        scripts.push({ id, bindings });
      }
      return scripts;
    };
    const first = await scan();
    if (first === null) return null;
    const second = await scan();
    return second !== null && JSON.stringify(first) === JSON.stringify(second) ? first : null;
  } catch {
    return null;
  }
}

// This observation is not atomic and does not authorize cleanup or establish account identity.
export async function observeTopologyRelationships(api, expected) {
  try {
    const scripts = await collectTopologyScriptInventory(api);
    if (scripts === null || !scripts.includes(expected?.script)) return null;
    const records = await collectTopologyNamespaceRecords(api, expected);
    if (records === null) return null;
    const settings = await collectTopologySettings(api, scripts);
    if (settings === null) return null;
    const namespaceIds = records.map(record => record.id);
    const namespaceClasses = Object.fromEntries(records.map(record => [record.id, record.className]));
    if (!validateTopologyBindings(settings, { script: expected.script, scripts, namespaceIds, namespaceClasses }))
      return null;
    const finalRecords = await collectTopologyNamespaceRecords(api, expected);
    const finalScripts = await collectTopologyScriptInventory(api);
    if (
      JSON.stringify(records) !== JSON.stringify(finalRecords) ||
      JSON.stringify(scripts) !== JSON.stringify(finalScripts)
    )
      return null;
    return { status: 'observed' };
  } catch {
    return null;
  }
}

export async function observeTopologyNamespaceAbsence(api, scriptName) {
  try {
    if (typeof scriptName !== 'string' || !/^miden-elig-topology-[1-9][0-9]{0,17}-[1-9][0-9]{0,5}$/.test(scriptName))
      return false;
    const scan = async () => {
      const pages = [];
      let totalPages = 1;
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
        const response = await api(`/workers/durable_objects/namespaces?page=${pageNumber}&per_page=1000`);
        if (pageNumber === 1) {
          totalPages = response?.result_info?.total_pages;
          if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > 100) return null;
        }
        pages.push(response);
      }
      return readTopologyNamespaceInventory(pages);
    };
    const first = await scan();
    if (first === null || first.some(entry => entry.script === scriptName)) return false;
    const second = await scan();
    return second !== null && JSON.stringify(first) === JSON.stringify(second);
  } catch {
    return false;
  }
}
