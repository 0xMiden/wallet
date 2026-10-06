# Fee asset discovery

- Publish new scope and override ownership before notifying listeners. A listener can synchronously call the same getter; notification before ownership changes can recursively invalidate the cache.
- Recheck the captured WASM hold and client generation after every caller-owned await before reading an SDK summary or another borrowed value. A check inside the awaited helper does not replace the caller's check.
- Serialize scoped identity writes with reset. A pre-write revision check alone cannot stop a parked storage write from completing after a newer identity or reset.
- Use authoritative native metadata for the actual fee identity even when a separate legacy display override is selected. Cached display decimals cannot set spend values or fee units.
- Treat each offscreen publication as a fresh bounded attempt, and invalidate local persistence acknowledgements when either durable identity record changes.
- Guard asynchronous fee hooks by generation so a parked result from the previous network cannot replace the current fee identity.
- Authorize fixed native pricing with exact canonical synchronized identity. Missing or mismatched proof cannot turn a native spend into an unpriced zero-value allowance charge.
- An ordinary cold native identity must not block an independently identified, allowlisted foreign price. Fatal identity errors retain their refusal behavior.
