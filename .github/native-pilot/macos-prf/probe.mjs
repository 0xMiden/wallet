import { inspectAuth, takePrf, sameBytes } from './probe-core.mjs';

const origin = location.origin;
const rpId = location.protocol === 'chrome-extension:' ? origin : location.hostname;
const button = id => document.getElementById(id);
let active;
let report = { scope: 'Environment probe only; wallet lifecycle not tested', status: 'not-run', origin };
const show = () => { button('result').textContent = JSON.stringify(report, null, 2); };
const random = size => crypto.getRandomValues(new Uint8Array(size));
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const journalKey = 'native-probe-credential-cleanup';
function ids() {
  const values = JSON.parse(localStorage.getItem(journalKey) || '[]');
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,1364}$/.test(v))) throw new Error('JOURNAL_INVALID');
  return values;
}
function retainId(id) {
  localStorage.setItem(journalKey, JSON.stringify([...new Set([...ids(), id])]));
}
function safeFailure(error) {
  const own = ['AUTH_DATA_INVALID', 'CLIENT_BINDING_INVALID', 'RP_HASH_INVALID', 'PRF_UNAVAILABLE', 'CREDENTIAL_INVALID', 'REPEAT_SALT_FAILED', 'CHANGED_SALT_FAILED', 'PLATFORM_UNAVAILABLE', 'JOURNAL_INVALID'];
  return own.includes(error?.message) ? error.message : ['NotAllowedError', 'NotSupportedError', 'SecurityError', 'AbortError', 'InvalidStateError', 'ConstraintError'].includes(error?.name) ? error.name : 'PROBE_FAILED';
}

button('run').addEventListener('click', async () => {
  if (active) return;
  active = new AbortController();
  const controller = active;
  const timeout = setTimeout(() => controller.abort(), 240_000);
  button('run').disabled = true;
  button('cleanup').disabled = true;
  button('cancel').disabled = false;
  const secrets = [];
  report = {
    scope: 'Environment probe only; wallet lifecycle not tested',
    targetProductSource: '10d2a7f2b3208d287b35a1276f83ce327f72f914',
    status: 'running', origin, browser: navigator.userAgent,
    startedAt: new Date().toISOString(), steps: []
  };
  show();
  try {
    if (!origin.startsWith('chrome-extension://') && !(location.protocol === 'http:' && location.hostname === 'localhost')) throw new Error('CLIENT_BINDING_INVALID');
    if (navigator.userAgentData) report.platform = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList']);
    report.platformAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!report.platformAvailable) throw new Error('PLATFORM_UNAVAILABLE');
    const signal = controller.signal;
    const salt = random(32);
    const extensions = value => ({ prf: { eval: { first: value } } });
    const check = async (credential, challenge, type, expectedId) => {
      if (!(credential instanceof PublicKeyCredential) || credential.type !== 'public-key' ||
          !(credential.rawId instanceof ArrayBuffer) || credential.rawId.byteLength < 1 || credential.rawId.byteLength > 1023 ||
          credential.id !== encode(new Uint8Array(credential.rawId)) || (expectedId && credential.id !== expectedId)) throw new Error('CREDENTIAL_INVALID');
      const ext = credential.getClientExtensionResults();
      const buffer = ext?.prf?.results?.first;
      if (buffer instanceof ArrayBuffer) secrets.push(new Uint8Array(buffer));
      const response = credential.response;
      const data = response instanceof AuthenticatorAttestationResponse ? new Uint8Array(response.getAuthenticatorData()) :
        response instanceof AuthenticatorAssertionResponse ? new Uint8Array(response.authenticatorData) : null;
      const binding = await inspectAuth(data, response.clientDataJSON, { challenge, origin, type, rpId });
      let secret = null;
      if (type === 'webauthn.get' || buffer !== undefined) secret = takePrf(ext);
      report.steps.push({ ceremony: type, ...binding, prfBytes: secret?.byteLength || 0, prfEnabledFlag: ext?.prf?.enabled === true });
      show();
      signal.throwIfAborted();
      return secret;
    };
    const challenge = random(32);
    report.stage = 'native-create'; show();
    const created = await navigator.credentials.create({ signal, publicKey: {
      challenge, rp: { name: 'Native extension-origin probe' },
      user: { id: random(64), name: 'native-test', displayName: 'Disposable native test' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      hints: ['client-device'], timeout: 60_000, extensions: extensions(salt)
    } });
    if (created instanceof PublicKeyCredential && /^[A-Za-z0-9_-]{1,1364}$/.test(created.id)) retainId(created.id);
    let first = await check(created, challenge, 'webauthn.create');
    const get = async (value, stage) => {
      report.stage = stage; show();
      const challenge = random(32);
      const credential = await navigator.credentials.get({ signal, publicKey: {
        challenge, userVerification: 'required', timeout: 60_000,
        allowCredentials: [{ type: 'public-key', id: created.rawId }], extensions: extensions(value)
      } });
      return check(credential, challenge, 'webauthn.get', created.id);
    };
    if (!first) first = await get(salt, 'native-first-prf');
    const repeat = await get(salt, 'native-repeat-salt');
    report.sameSaltEqual = sameBytes(first, repeat);
    if (!report.sameSaltEqual) throw new Error('REPEAT_SALT_FAILED');
    const changed = await get(random(32), 'native-changed-salt');
    report.changedSaltDifferent = !sameBytes(first, changed);
    if (!report.changedSaltDifferent) throw new Error('CHANGED_SALT_FAILED');
    report.status = 'passed-environment-probe';
  } catch (error) {
    report.status = 'failed';
    report.failure = safeFailure(error);
  } finally {
    for (const secret of secrets) secret.fill(0);
    clearTimeout(timeout);
    report.finishedAt = new Date().toISOString();
    active = undefined;
    button('run').disabled = false;
    button('cleanup').disabled = false;
    button('cancel').disabled = true;
    show();
  }
});
button('cancel').addEventListener('click', () => active?.abort());
button('cleanup').addEventListener('click', async () => {
  if (active) return;
  let signaled = 0;
  try {
    for (const credentialId of ids()) {
      await PublicKeyCredential.signalUnknownCredential({ rpId, credentialId });
      signaled++;
    }
    localStorage.removeItem(journalKey);
    report.cleanup = { signalsAcknowledged: signaled, note: 'Signal acknowledgment is not proof of credential deletion' };
  } catch (error) { report.cleanup = { signalsAcknowledged: signaled, failure: safeFailure(error) }; }
  show();
});
button('save').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'native-prf-metadata.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
show();
