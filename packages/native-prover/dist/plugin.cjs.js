'use strict';

var core = require('@capacitor/core');

// Capacitor's `registerPlugin` returns a stub that throws "X has no
// implementation available" on platforms where the plugin isn't bundled.
// On iOS/Android, Capacitor wires it to the native Swift/Kotlin impl
// at app launch. We do NOT pass a `web` fallback — the wallet should
// surface a clear error if it ever tries to use this plugin from the
// extension or desktop build, rather than silently using a stub.
const MidenNativeProver = core.registerPlugin('MidenNativeProver');

exports.MidenNativeProver = MidenNativeProver;
//# sourceMappingURL=plugin.cjs.js.map
