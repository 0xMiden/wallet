/** Log publish steps without request bytes, signatures, or key material. */
export async function traceRegistryStep<T>(
  step: string,
  operation: () => Promise<T>,
  context: Record<string, string | number | boolean> = {},
  enabled = true
): Promise<T> {
  if (!enabled) return operation();
  const startedAt = Date.now();
  console.log(`[registry-debug] ${step}: start`, context);
  try {
    const result = await operation();
    console.log(`[registry-debug] ${step}: done`, { ...context, elapsedMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    console.log(`[registry-debug] ${step}: failed`, {
      ...context,
      elapsedMs: Date.now() - startedAt,
      errorName: error instanceof Error ? error.name : typeof error
    });
    throw error;
  }
}
