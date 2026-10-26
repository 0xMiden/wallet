import { createListenerSet } from 'lib/listener-set';

// A confirmation tap and the side-panel auto-register hold this for the whole attempt, including
// when registration throws. OnboardingNetwork waits out its own mainnet preparation while it is set:
// the attempt prepares mainnet itself, and a second preparation would cover the screen still in use.
const { subscribe, notify } = createListenerSet();

let registrationActive = false;

export function onboardingRegistrationActive(): boolean {
  return registrationActive;
}

export function setOnboardingRegistrationActive(active: boolean): void {
  if (active === registrationActive) return;
  registrationActive = active;
  notify();
}

export function subscribeOnboardingRegistration(listener: () => void): () => void {
  return subscribe(listener);
}
