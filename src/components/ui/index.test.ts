/**
 * The `components/ui` barrel is a pure re-export module: every line is a
 * `export … from './X'` that forwards a component's runtime binding (the
 * `export type` lines are erased by the transformer and carry no runtime
 * surface). Importing the barrel therefore exercises every re-export line and
 * every leaf module it forwards. We assert that each named component is a
 * live React component and that the barrel does not leak anything unexpected.
 */

import fs from 'fs';
import path from 'path';

import { AccountsDrawer } from './AccountsDrawer';
import { ActivityRow } from './ActivityRow';
import { AlertSheet } from './AlertSheet';
import { AnimatedCopyIcon } from './AnimatedCopyIcon';
import { AnimatedNumber } from './AnimatedNumber';
import { AssetListItem } from './AssetListItem';
import { Avatar } from './Avatar';
import { BalanceCard } from './BalanceCard';
import { BottomNav } from './BottomNav';
import { Button, ButtonVariant } from './Button';
import { Card, CardButton } from './Card';
import { CheckboxIndicator, CheckboxRow } from './Checkbox';
import ChoiceCard, { ChoiceCardGroup } from './ChoiceCard';
import { CopyButton } from './CopyButton';
import { CopyChip } from './CopyChip';
import { CopyLabel } from './CopyLabel';
import { DetailCard, DetailRow } from './DetailCard';
import { EmptyState } from './EmptyState';
import { ErrorLine } from './ErrorLine';
import { HeaderRule } from './HeaderRule';
import { Hero } from './Hero';
import { IconButton } from './IconButton';
import * as UI from './index';
import { InfoHint } from './InfoHint';
import { ListGroup } from './ListGroup';
import { ListRow } from './ListRow';
import { Notice } from './Notice';
import { Pill } from './Pill';
import { Popover } from './Popover';
import { PromptCard } from './PromptCard';
import { PromptCarousel } from './PromptCarousel';
import { SearchInput } from './SearchInput';
import { SectionHeader } from './SectionHeader';
import { SeedPhraseGrid } from './SeedPhraseGrid';
import { SegmentedActionBar } from './SegmentedActionBar';
import { SegmentedControl } from './SegmentedControl';
import { SelectionCheck } from './SelectionCheck';
import { Skeleton } from './Skeleton';
import { Sparkline } from './Sparkline';
import { Spinner } from './Spinner';
import { StatusBadge } from './StatusBadge';
import { SubPageLayout } from './SubPageLayout';
import { TabHeader, TabHeaderAction } from './TabHeader';
import { TabRootHeader } from './TabRootHeader';
import { TextAction } from './TextAction';
import { TextField } from './TextField';
import { WaveDots } from './WaveDots';

// vaul (the drawer primitive AccountsDrawer pulls in) walks the DOM on load;
// jsdom lacks the layout APIs it probes, so stub it to a passthrough. This
// mirrors how the sibling AccountsDrawer test isolates the drawer tree.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => children,
  DrawerContent: ({ children }: { children: React.ReactNode }) => children,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => children,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => children
}));

// CopyButton pulls in the Capacitor clipboard plugin, which reaches native
// bridges outside jsdom; stub it the same way CopyButton.test.tsx does.
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: jest.fn().mockResolvedValue(undefined) } }));

describe('components/ui barrel', () => {
  // Every runtime (value) export the barrel is expected to forward. Types are
  // compile-time only and never appear on the module object.
  const EXPECTED_COMPONENTS = {
    AccountsDrawer,
    AlertSheet,
    AnimatedNumber,
    Avatar,
    InfoHint,
    Pill,
    StatusBadge,
    WaveDots,
    BalanceCard,
    CopyButton,
    CopyChip,
    AnimatedCopyIcon,
    CopyLabel,
    PromptCard,
    PromptCarousel,
    AssetListItem,
    SegmentedActionBar,
    SegmentedControl,
    SelectionCheck,
    BottomNav,
    HeaderRule,
    TabHeader,
    TabHeaderAction,
    TabRootHeader,
    SearchInput,
    Sparkline,
    ActivityRow,
    EmptyState,
    IconButton,
    Popover,
    Spinner,
    Skeleton,
    TextField,
    Button,
    DetailCard,
    DetailRow,
    Hero,
    ListGroup,
    ListRow,
    Notice,
    SectionHeader,
    Card,
    CardButton,
    ChoiceCard,
    Checkbox: CheckboxRow,
    CheckboxIndicator,
    CheckboxRow,
    ChoiceCardGroup,
    TextAction,
    SubPageLayout,
    ErrorLine,
    SeedPhraseGrid
  } as const;

  // Runtime values the barrel forwards that are NOT components. `ButtonVariant` is a real `enum`,
  // so it is an object on the module - it belongs in the key set but would fail the renderable
  // check below.
  const EXPECTED_NON_COMPONENT_VALUES = { ButtonVariant } as const;

  it('re-exports every component under its own name, tied to the source module', () => {
    (Object.keys(EXPECTED_COMPONENTS) as Array<keyof typeof EXPECTED_COMPONENTS>).forEach(name => {
      // Present on the barrel …
      expect(UI).toHaveProperty(name);
      // … and === the binding exported by the underlying component module
      // (proves the barrel forwards, rather than redeclares, each component).
      expect((UI as Record<string, unknown>)[name]).toBe(EXPECTED_COMPONENTS[name]);
    });
  });

  // A plain function component (typeof === 'function') renders directly; a React.forwardRef
  // component is instead an object tagged with this $$typeof — both render. `value` is `unknown`
  // so the check works uniformly across the record's differently-typed components, with no `as`.
  const isRenderableComponent = (value: unknown): boolean => {
    if (typeof value === 'function') return true;
    return (
      typeof value === 'object' &&
      value !== null &&
      '$$typeof' in value &&
      value.$$typeof === Symbol.for('react.forward_ref')
    );
  };

  it('exposes each re-export as a renderable React component (function, or a forwardRef object)', () => {
    Object.values(EXPECTED_COMPONENTS).forEach(component => {
      expect(isRenderableComponent(component)).toBe(true);
    });
  });

  it('forwards exactly the expected runtime bindings and nothing else', () => {
    // `export type` lines contribute no runtime keys, so the module object's
    // own enumerable keys must be precisely the component set plus the non-component values.
    const runtimeKeys = Object.keys(UI).sort();
    const expected = [...Object.keys(EXPECTED_COMPONENTS), ...Object.keys(EXPECTED_NON_COMPONENT_VALUES)];
    expect(runtimeKeys).toEqual(expected.sort());
  });

  // The assertions above pin what the barrel DOES export. They cannot see a primitive that is
  // missing from both the barrel and the record, which is how Button, DetailCard, Hero, ListGroup,
  // ListRow and SectionHeader all sat in this directory unexported without a test noticing.
  // Deriving the expectation from the directory closes that direction. Secondary exports
  // (DetailRow from DetailCard, TabHeaderAction from TabHeader) stay legal: this only requires
  // that each module's OWN name is reachable, not that it is the module's only export.
  it('exports every component module in this directory under its own name', () => {
    const moduleNames = fs
      .readdirSync(__dirname)
      .filter(f => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .map(f => path.basename(f, '.tsx'))
      .sort();

    expect(moduleNames.length).toBeGreaterThan(0);
    expect(moduleNames.filter(name => !(name in UI))).toEqual([]);
  });

  it('does not forward any undefined bindings', () => {
    Object.entries(UI).forEach(([name, value]) => {
      expect(value).toBeDefined();
      expect(name).toBeTruthy();
    });
  });
});
