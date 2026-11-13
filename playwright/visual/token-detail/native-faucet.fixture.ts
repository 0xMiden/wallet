export default function useMidenFaucetId() {
  return new URLSearchParams(window.location.search).has('nativeUnknown') ? null : 'mtst1native';
}
