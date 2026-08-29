/**
 * The `components/ui` barrel is a pure re-export module: every line is a
 * `export … from './X'` that forwards a component's runtime binding (the
 * `export type` lines are erased by the transformer and carry no runtime
 * surface). Importing the barrel therefore exercises every re-export line and
 * every leaf module it forwards. We assert that each named component is a
 * live React component and that the barrel does not leak anything unexpected.
 */

import { AccountsDrawer } from './AccountsDrawer';
import { ActivityRow } from './ActivityRow';
import { AddAccountDrawer } from './AddAccountDrawer';
import { AssetListItem } from './AssetListItem';
import { BalanceCard } from './BalanceCard';
import { BottomNav } from './BottomNav';
import * as UI from './index';
import { PromptCard } from './PromptCard';
import { PromptCarousel } from './PromptCarousel';
import { SearchInput } from './SearchInput';
import { SegmentedActionBar } from './SegmentedActionBar';
import { Sparkline } from './Sparkline';
import { TabHeader } from './TabHeader';

// vaul (the drawer primitive AccountsDrawer pulls in) walks the DOM on load;
// jsdom lacks the layout APIs it probes, so stub it to a passthrough. This
// mirrors how the sibling AccountsDrawer test isolates the drawer tree.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => children,
  DrawerContent: ({ children }: { children: React.ReactNode }) => children,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => children,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => children
}));

describe('components/ui barrel', () => {
  // Every runtime (value) export the barrel is expected to forward. Types are
  // compile-time only and never appear on the module object.
  const EXPECTED_COMPONENTS = {
    AccountsDrawer,
    AddAccountDrawer,
    BalanceCard,
    PromptCard,
    PromptCarousel,
    AssetListItem,
    SegmentedActionBar,
    BottomNav,
    TabHeader,
    SearchInput,
    Sparkline,
    ActivityRow
  } as const;

  it('re-exports every component under its own name, tied to the source module', () => {
    (Object.keys(EXPECTED_COMPONENTS) as Array<keyof typeof EXPECTED_COMPONENTS>).forEach(name => {
      // Present on the barrel …
      expect(UI).toHaveProperty(name);
      // … and === the binding exported by the underlying component module
      // (proves the barrel forwards, rather than redeclares, each component).
      expect((UI as Record<string, unknown>)[name]).toBe(EXPECTED_COMPONENTS[name]);
    });
  });

  it('exposes each re-export as a renderable React component (function type)', () => {
    Object.values(EXPECTED_COMPONENTS).forEach(component => {
      expect(typeof component).toBe('function');
    });
  });

  it('forwards exactly the expected runtime bindings and nothing else', () => {
    // `export type` lines contribute no runtime keys, so the module object's
    // own enumerable keys must be precisely the component set.
    const runtimeKeys = Object.keys(UI).sort();
    expect(runtimeKeys).toEqual(Object.keys(EXPECTED_COMPONENTS).sort());
  });

  it('does not forward any undefined bindings', () => {
    Object.entries(UI).forEach(([name, value]) => {
      expect(value).toBeDefined();
      expect(name).toBeTruthy();
    });
  });
});
