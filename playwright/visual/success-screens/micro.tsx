// The six microinteractions in the working tree's app code, each on the real component with a
// button that triggers it. Nothing here is a mock: these are the files under src/components/ui.
import React, { FC, ReactNode, useState } from 'react';

import { ContactAvatar } from '../../../src/components/contacts/ContactAvatar';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { AssetListItem } from '../../../src/components/ui/AssetListItem';
import { CodeInput } from '../../../src/components/ui/CodeInput';
import { ErrorLine } from '../../../src/components/ui/ErrorLine';
import { ProgressMeter } from '../../../src/components/ui/ProgressMeter';
import { SeedPhraseGrid } from '../../../src/components/ui/SeedPhraseGrid';
import { TextField } from '../../../src/components/ui/TextField';
import { UnreadDot } from '../../../src/components/ui/UnreadDot';
import { IETH, USDCX } from './fixture';

const WORDS = ['maple', 'orbit', 'candle', 'river', 'tunnel', 'acorn', 'velvet', 'harbor', 'pencil', 'lantern', 'meadow', 'copper'];

const trigger: React.CSSProperties = {
  border: 0,
  background: '#e77537',
  color: '#fff',
  font: "700 14px 'Nunito'",
  padding: '8px 16px',
  borderRadius: 999,
  cursor: 'pointer'
};

const Card: FC<{ n: number; title: string; file: string; what: string; action: ReactNode; children: ReactNode }> = ({
  n,
  title,
  file,
  what,
  action,
  children
}) => (
  <section data-micro={n} style={{ width: 393, display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div>
      <div style={{ font: "800 16px 'Nunito'" }}>
        {n}. {title}
      </div>
      <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', marginTop: 2 }}>{what}</div>
      <div style={{ font: "600 12px ui-monospace, monospace", color: '#8a847c', marginTop: 4 }}>{file}</div>
    </div>
    <div>{action}</div>
    <div className="bg-page text-ink" style={{ borderRadius: 24, boxShadow: '0 0 0 1px #e6e1da', padding: 16, minHeight: 150 }}>
      {children}
    </div>
  </section>
);

export const MicroTab: FC = () => {
  const [code, setCode] = useState('4821');
  const [badCode, setBadCode] = useState(false);
  const [lineError, setLineError] = useState(false);
  const [fieldError, setFieldError] = useState(false);
  const [progress, setProgress] = useState(2);
  const [masked, setMasked] = useState(true);
  const [unread, setUnread] = useState(false);

  return (
    <>
      <div style={{ font: "400 14px 'Nunito'", color: '#6b6b6b', marginBottom: 20, maxWidth: 820 }}>
        The six microinteractions in the app code on this branch, uncommitted. Each one is the real component; press its orange button
        to play it.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32 }}>
        <Card
          n={1}
          title="Wrong code shakes"
          file="CodeInput.tsx"
          what="A code that turns invalid shakes the cells once, with the error haptic on a phone. The field keeps its focus."
          action={
            <button
              style={trigger}
              onClick={() => {
                setBadCode(false);
                requestAnimationFrame(() => setBadCode(true));
              }}
            >
              Reject the code
            </button>
          }
        >
          <CodeInput
            value={code}
            onChange={value => {
              setCode(value);
              setBadCode(false);
            }}
            label="Access code"
            length={6}
            invalid={badCode}
          />
        </Card>

        <Card
          n={2}
          title="Errors open instead of jumping"
          file="ErrorLine.tsx, TextField.tsx"
          what="An error that arrives opens its own height, so what is below slides down. Clearing it is instant."
          action={
            <span style={{ display: 'flex', gap: 8 }}>
              <button style={trigger} onClick={() => setFieldError(value => !value)}>
                {fieldError ? 'Clear field error' : 'Show field error'}
              </button>
              <button style={trigger} onClick={() => setLineError(value => !value)}>
                {lineError ? 'Clear line error' : 'Show line error'}
              </button>
            </span>
          }
        >
          <TextField label="Recipient" defaultValue="mtst1apqk2y2" error={fieldError ? 'That is not a valid address.' : undefined} />
          <div className="mt-3 text-body-sm text-muted">Content below the field.</div>
          <ErrorLine className="mt-2">{lineError ? 'Could not reach the network. Try again.' : null}</ErrorLine>
          <div className="mt-3 text-body-sm text-muted">Content below the error line.</div>
        </Card>

        <Card
          n={3}
          title="Progress bar travels"
          file="ProgressMeter.tsx"
          what="The bar moves to a new value on a spring instead of snapping, and its end stays round at every value."
          action={
            <span style={{ display: 'flex', gap: 8 }}>
              <button style={trigger} onClick={() => setProgress(value => Math.min(value + 1, 8))}>
                Earn one
              </button>
              <button style={{ ...trigger, background: '#3f3f3f' }} onClick={() => setProgress(0)}>
                Reset
              </button>
            </span>
          }
        >
          <div className="mb-2 text-value text-ink">{progress} of 8 badges</div>
          <ProgressMeter value={progress} max={8} aria-label="Badges earned" />
        </Card>

        <Card
          n={4}
          title="Seed words fade in, one after another"
          file="SeedPhraseGrid.tsx"
          what="When the bars are replaced by the words, each word fades in 30ms after the one before."
          action={
            <button style={trigger} onClick={() => setMasked(value => !value)}>
              {masked ? 'Reveal the phrase' : 'Hide it again'}
            </button>
          }
        >
          <SeedPhraseGrid words={WORDS} masked={masked} />
        </Card>

        <Card
          n={5}
          title="Unread dot pops in"
          file="UnreadDot.tsx"
          what="A dot that arrives while you are looking pops in. One that is read disappears at once."
          action={
            <button style={trigger} onClick={() => setUnread(value => !value)}>
              {unread ? 'Mark as read' : 'New activity arrives'}
            </button>
          }
        >
          <div className="relative flex items-center gap-3 py-2 pl-4">
            <UnreadDot unread={unread} label="Unread" />
            <ContactAvatar address="mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x" name="Maya" size="md" />
            <div>
              <div className="text-row-title text-ink">Received from Maya</div>
              <div className="text-caption text-muted">25 USDCX · just now</div>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3 pl-4">
            <span className="relative flex size-10 items-center justify-center rounded-full bg-fill text-value text-ink">
              3
              <UnreadDot unread={unread} placement="badge" label="Unread" />
            </span>
            <span className="text-caption text-muted">The same dot on an icon button</span>
          </div>
        </Card>

        <Card
          n={6}
          title="Token rows show a press"
          file="AssetListItem.tsx"
          what="Pressing a token row fills it grey, like the other list rows, instead of only dimming slightly."
          action={<span style={{ font: "700 14px 'Nunito'", color: '#3f3f3f' }}>Press and hold a row below</span>}
        >
          <AssetListItem icon={<TokenLogo faucetId={USDCX} size="md" />} name="USDCX" amount="140.5" price="$140.50" onClick={() => undefined} />
          <AssetListItem icon={<TokenLogo faucetId={IETH} size="md" />} name="iETH" amount="0.82" price="$2,853.60" onClick={() => undefined} />
        </Card>
      </div>
    </>
  );
};
