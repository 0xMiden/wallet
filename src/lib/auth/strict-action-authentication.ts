export type StrictAuthenticationPlatform = 'extension' | 'mobile' | 'desktop' | 'web';
export type StrictAuthenticationMethod = 'hardware' | 'passcode' | 'password';
export type StrictAuthenticationResult = 'authenticated' | 'cancelled';

export interface StrictAuthenticationProtectors {
  hardware: boolean;
  password: boolean;
}

export interface StrictActionAuthenticationDependencies {
  getPlatform: () => StrictAuthenticationPlatform;
  loadProtectors: () => Promise<StrictAuthenticationProtectors>;
  verify: (credential?: string) => Promise<void>;
}

export interface StrictActionAuthenticationChallenge {
  method: Promise<StrictAuthenticationMethod | undefined>;
  authenticate: (credential?: string) => Promise<StrictAuthenticationResult>;
  cancel: () => void;
}

const selectMethod = (
  platform: StrictAuthenticationPlatform,
  protectors: StrictAuthenticationProtectors
): StrictAuthenticationMethod | undefined => {
  if ((platform === 'mobile' || platform === 'desktop') && protectors.hardware) return 'hardware';
  if (!protectors.password) return undefined;
  return platform === 'mobile' ? 'passcode' : 'password';
};

export const createStrictActionAuthenticationController = (dependencies: StrictActionAuthenticationDependencies) => {
  let generation = 0;

  return {
    begin(): StrictActionAuthenticationChallenge {
      const challengeGeneration = ++generation;
      const method = dependencies
        .loadProtectors()
        .then(protectors =>
          generation === challengeGeneration ? selectMethod(dependencies.getPlatform(), protectors) : undefined
        )
        .catch(() => undefined);
      let attempt: Promise<StrictAuthenticationResult> | undefined;

      return {
        method,
        authenticate(credential) {
          if (attempt !== undefined) return attempt;
          let pendingCredential = credential;
          attempt = (async () => {
            try {
              const selectedMethod = await method;
              if (generation !== challengeGeneration || selectedMethod === undefined) return 'cancelled';
              if (selectedMethod !== 'hardware' && !pendingCredential) return 'cancelled';
              await dependencies.verify(selectedMethod === 'hardware' ? undefined : pendingCredential);
              return generation === challengeGeneration ? 'authenticated' : 'cancelled';
            } catch {
              return 'cancelled';
            } finally {
              pendingCredential = undefined;
            }
          })();
          return attempt;
        },
        cancel() {
          if (generation === challengeGeneration) generation++;
        }
      };
    }
  };
};
