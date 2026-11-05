import React, { ReactNode } from 'react';

import { Icon, IconName } from 'app/icons/v2';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import type { ChoiceCardItem } from 'components/ui/ChoiceCard';
import { Pill } from 'components/ui/Pill';
import { StatusBadge } from 'components/ui/StatusBadge';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';

export interface GuardianOperatorCardInput {
  option: ResolvedGuardianOption;
  /** The meta line under the operator's name. */
  subtitle: ReactNode;
  /** The card's tag ("Current", "Default", "Fastest"), or none. */
  tag?: string;
  /** The operator answered offline. */
  offline: boolean;
  /** The provider sheet's "Fastest": a white pill with the bolt on the card's top edge instead of beside the title. */
  edgeTag?: string;
}

/**
 * One guardian operator as a choice card, drawn the same in Rotate Guardian's picker and the create flow's
 * provider sheet: its logo tile, its tag beside the offline verdict (never instead of it), and the endpoint
 * hook E2E selects it by. An offline operator cannot be chosen: an account created against a down operator
 * fails deep in the pipeline, after the user has already backed up a seed phrase and set a password.
 */
export function guardianOperatorCard({
  option,
  subtitle,
  tag,
  offline,
  edgeTag
}: GuardianOperatorCardInput): ChoiceCardItem {
  return {
    id: option.id,
    title: option.name,
    subtitle,
    leading: <GuardianLogoTile guardianId={option.id} />,
    badge:
      tag || offline ? (
        <>
          {tag && (
            <Pill size="xs" tone="inactive">
              {tag}
            </Pill>
          )}
          {offline && <StatusBadge status="offline" data-testid="guardian-offline-banner" />}
        </>
      ) : undefined,
    edgeBadge: edgeTag ? (
      <Pill
        size="xs"
        className="border-hairline bg-action-bar font-semibold text-ink face-heading"
        icon={<Icon name={IconName.Bolt} fill="currentColor" className="text-accent-primary" />}
      >
        {edgeTag}
      </Pill>
    ) : undefined,
    disabled: offline,
    data: { 'data-guardian-endpoint': option.endpoint }
  };
}
