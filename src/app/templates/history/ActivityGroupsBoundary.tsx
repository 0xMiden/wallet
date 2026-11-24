import React, { Component, ErrorInfo, ReactNode } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { EmptyState } from 'components/ui/EmptyState';
import { TextAction } from 'components/ui/TextAction';
import { captureCrash } from 'lib/telemetry/crash';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';

type Props = { children: ReactNode; onReturnToList: () => void };

/** Contains only the Groups renderer; history reads and wallet failures keep their own handling. */
export class ActivityGroupsBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error.message, info.componentStack);
    try {
      captureCrash(error, 'react');
    } catch {
      // Reporting must not replace the scoped recovery UI with another error.
    }
  }

  render() {
    return this.state.failed ? (
      <GroupsRecovery onRetry={() => this.setState({ failed: false })} onReturnToList={this.props.onReturnToList} />
    ) : (
      this.props.children
    );
  }
}

function GroupsRecovery({ onRetry, onReturnToList }: { onRetry: () => void; onReturnToList: () => void }) {
  const { t } = useTranslation();
  useUserVisibleError('smthWentWrong', 'inline');
  return (
    <div role="alert" className="flex flex-col items-center gap-2 pt-4">
      <EmptyState
        icon={IconName.Frown}
        title={t('activityGroupsUnavailable')}
        description={t('activityGroupsUnavailableDescription')}
        secondaryAction={{ label: t('activityReturnToList'), onClick: onReturnToList }}
        className="w-full"
      />
      <TextAction onClick={onRetry}>{t('tryAgain')}</TextAction>
    </div>
  );
}
