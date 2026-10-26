export function ownDiagnosticData(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
    throw new Error('Diagnostic accessor refused');
  return descriptor?.value;
}

export function safeOwnDiagnosticData(value: unknown, key: string): unknown {
  try {
    return ownDiagnosticData(value, key);
  } catch {
    return undefined;
  }
}

export function closedDiagnosticPair<T>(
  value: unknown,
  fields: Readonly<Record<string, readonly string[]>>
): T | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    if (
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(fields, key))
    )
      return undefined;
    const safe: Record<string, string> = {};
    for (const [key, allowed] of Object.entries(fields)) {
      const supplied = ownDiagnosticData(value, key);
      const member = allowed.find(item => item === supplied);
      if (member === undefined) return undefined;
      safe[key] = member;
    }
    return safe as T;
  } catch {
    return undefined;
  }
}

export function rootDiagnosticStore<T>(validate: (value: unknown) => T | undefined) {
  const observations = new WeakMap<object, T>();
  return {
    annotate(error: unknown, value: unknown): void {
      try {
        if (typeof error !== 'object' || error === null) return;
        const safe = validate(value);
        if (safe === undefined) observations.delete(error);
        else observations.set(error, safe);
      } catch {
        /* Observation cannot replace the original rejection. */
      }
    },
    snapshot(error: unknown): T | undefined {
      try {
        return typeof error === 'object' && error !== null ? validate(observations.get(error)) : undefined;
      } catch {
        return undefined;
      }
    }
  };
}
