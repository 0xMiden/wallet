import React, { FC, ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';

import classNames from 'clsx';
import { formatDistanceToNowStrict } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ActivityRow } from 'components/ui';
import { useAgglayerBridgeInNotifications } from 'lib/agglayer';
import { formatBigInt } from 'lib/i18n/numbers';
import { useAccount } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import {
  AgglayerBridgeInNotification,
  AppNotification,
  EpochBridgeInNotification,
  PendingNoteNotification,
  TransactionNotification
} from 'lib/store/notifications';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

interface NotificationsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const NotificationsDrawer: FC<NotificationsDrawerProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const markAllNotificationsRead = useWalletStore(s => s.markAllNotificationsRead);
  const notifications = useWalletStore(s => s.notificationsByAccount[account.publicKey]);

  // Poll the Agglayer indexer for incoming deposits only while the drawer is open.
  useAgglayerBridgeInNotifications(open, account.publicKey);

  const { pendingNotes, events } = useMemo(() => {
    const all = notifications ?? [];
    return {
      pendingNotes: all.filter((n): n is PendingNoteNotification => n.kind === 'pending-note'),
      events: [...all.filter(n => n.kind !== 'pending-note')].sort((a, b) => b.createdAt - a.createdAt)
    };
  }, [notifications]);

  // Closing the drawer counts as having seen the notifications — unread dots
  // stay visible while it's open, the badge clears once it's dismissed.
  const markRead = useCallback(
    () => markAllNotificationsRead(account.publicKey),
    [markAllNotificationsRead, account.publicKey]
  );
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) markRead();
    wasOpen.current = open;
  }, [open, markRead]);
  useEffect(
    () => () => {
      if (wasOpen.current) markRead();
    },
    [markRead]
  );

  const closeAndNavigate = (pathname: string) => {
    markRead();
    onOpenChange(false);
    navigate(pathname);
  };

  const isEmpty = pendingNotes.length === 0 && events.length === 0;
  const rowCount = (pendingNotes.length > 0 ? 1 : 0) + events.length;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('notifications')}</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-6 overflow-y-auto min-h-0">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center py-10">
              <p className="text-sm text-center text-text-tertiary-token">{t('noNotificationsYet')}</p>
            </div>
          ) : (
            <>
              {pendingNotes.length > 0 && (
                <NotificationRowShell unread={pendingNotes.some(n => n.readAt === null)} isLast={rowCount === 1}>
                  <PendingNotesSummaryRow notifications={pendingNotes} onNavigate={closeAndNavigate} />
                </NotificationRowShell>
              )}
              {events.map((notification, index) => (
                <NotificationRowShell
                  key={notification.id}
                  unread={notification.readAt === null}
                  isLast={index === events.length - 1}
                >
                  <NotificationRow notification={notification} onNavigate={closeAndNavigate} />
                </NotificationRowShell>
              ))}
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};

const NotificationRowShell: FC<{ unread: boolean; isLast: boolean; children: ReactNode }> = ({
  unread,
  isLast,
  children
}) => (
  <div className={classNames('flex items-center gap-2', !isLast && 'border-b border-rule-default')}>
    {unread && <span className="w-2 h-2 rounded-full shrink-0 bg-accent-primary" />}
    <div className="flex-1 min-w-0">{children}</div>
  </div>
);

function useRelativeTime(): (timestamp: number) => string {
  const { t } = useTranslation();
  return useCallback(
    (timestamp: number) => {
      // date-fns renders the sub-minute window as "X seconds ago" —
      // the design wants "Just now".
      if (Date.now() - timestamp < 60_000) return t('justNow');
      return formatDistanceToNowStrict(timestamp, { addSuffix: true });
    },
    [t]
  );
}

const PendingNotesSummaryRow: FC<{
  notifications: PendingNoteNotification[];
  onNavigate: (pathname: string) => void;
}> = ({ notifications, onNavigate }) => {
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();
  const newest = notifications.reduce((max, n) => Math.max(max, n.createdAt), 0);

  return (
    <ActivityRow
      icon={<Icon name={IconName.Download} className="w-5 h-5" fill="currentColor" />}
      iconBg="bg-tx-received"
      title={t('incomingNotesToClaim', { count: notifications.length })}
      subtitle={t('tapToViewAll')}
      timestamp={relativeTime(newest)}
      onClick={() => onNavigate('/pending-notes')}
    />
  );
};

interface NotificationRowProps {
  notification: AppNotification;
  onNavigate: (pathname: string) => void;
}

const NotificationRow: FC<NotificationRowProps> = ({ notification, onNavigate }) => {
  switch (notification.kind) {
    case 'pending-note':
      // Pending notes render through PendingNotesSummaryRow.
      return null;
    case 'transaction':
      return <TransactionRow notification={notification} onNavigate={onNavigate} />;
    case 'bridge-in-agglayer':
      return <AgglayerBridgeInRow notification={notification} onNavigate={onNavigate} />;
    case 'bridge-in-epoch':
      return <EpochBridgeInRow notification={notification} onNavigate={onNavigate} />;
  }
};

const TransactionRow: FC<{ notification: TransactionNotification; onNavigate: (pathname: string) => void }> = ({
  notification,
  onNavigate
}) => {
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();
  const { payload } = notification;
  const failed = payload.status === 'failed';

  const formattedAmount =
    payload.amount !== undefined && payload.decimals !== undefined
      ? formatBigInt(BigInt(payload.amount), payload.decimals)
      : undefined;
  const symbol = payload.symbol ?? '';
  const hasAmount = formattedAmount !== undefined && payload.symbol !== undefined;

  // Icon + accent follow the HistoryView mapping for the same tx types.
  let icon: ReactNode = <Icon name={IconName.More} className="w-5 h-5" fill="currentColor" />;
  let iconBg = 'bg-gray-50';
  if (failed) {
    icon = <Icon name={IconName.Close} className="w-5 h-5" fill="currentColor" />;
    iconBg = 'bg-status-negative';
  } else if (payload.txType === 'consume') {
    icon = <Icon name={IconName.Download} className="w-5 h-5" fill="currentColor" />;
    iconBg = 'bg-tx-received';
  } else if (payload.txType === 'send') {
    const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    icon = <Icon name={IconName.Send} size="xs" fill={isDark ? 'white' : 'currentColor'} />;
    iconBg = 'bg-tx-sent';
  } else if (payload.txType === 'bridged-send') {
    icon = <Icon name={IconName.Convert} className="w-5 h-5" fill="currentColor" />;
    iconBg = 'bg-tx-swap';
  }

  let title: string;
  if (payload.txType === 'bridged-send') {
    title = failed
      ? t('notificationBridgeOutFailedTitle')
      : hasAmount
        ? t('notificationBridgeOutTitle', { amount: formattedAmount, symbol })
        : (payload.displayMessage ?? t('notificationTxCompletedTitle'));
  } else if (failed) {
    title = t('transactionFailed');
  } else if (payload.txType === 'send' && hasAmount) {
    title = t('notificationSentTitle', { amount: formattedAmount, symbol });
  } else if (payload.txType === 'consume' && hasAmount) {
    title =
      payload.displayMessage === 'Reclaimed'
        ? t('notificationReclaimedTitle', { amount: formattedAmount, symbol })
        : t('notificationClaimedTitle', { amount: formattedAmount, symbol });
  } else {
    title = payload.displayMessage ?? t('notificationTxCompletedTitle');
  }

  let subtitle: string | undefined;
  if (failed) {
    subtitle = payload.error ?? payload.displayMessage;
  } else if (payload.txType === 'bridged-send') {
    const parts: string[] = [];
    if (payload.destinationAddress) parts.push(`${t('to')}: ${truncateAddress(payload.destinationAddress)}`);
    if (payload.provider) parts.push(t('notificationVia', { provider: payload.provider }));
    subtitle = parts.length > 0 ? parts.join(' · ') : undefined;
  }

  return (
    <ActivityRow
      icon={icon}
      iconBg={iconBg}
      title={title}
      subtitle={subtitle}
      timestamp={relativeTime(notification.createdAt)}
      onClick={() => onNavigate(`/history-details/${payload.txId}`)}
    />
  );
};

const AgglayerBridgeInRow: FC<{
  notification: AgglayerBridgeInNotification;
  onNavigate: (pathname: string) => void;
}> = ({ notification, onNavigate }) => {
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();
  const { payload } = notification;

  const amount = formatBigInt(BigInt(payload.amount), payload.decimals);
  const titleKey = payload.readyForClaim ? 'notificationBridgeInReadyTitle' : 'notificationBridgeInProgressTitle';

  return (
    <ActivityRow
      icon={<Icon name={IconName.Convert} className="w-5 h-5" fill="currentColor" />}
      iconBg="bg-tx-swap"
      title={t(titleKey, { amount, symbol: payload.symbol })}
      subtitle={t('notificationVia', { provider: 'agglayer' })}
      timestamp={relativeTime(notification.createdAt)}
      onClick={() => onNavigate('/history')}
    />
  );
};

const EpochBridgeInRow: FC<{ notification: EpochBridgeInNotification; onNavigate: (pathname: string) => void }> = ({
  notification,
  onNavigate
}) => {
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();
  const { payload } = notification;
  const failed = payload.status === 'failed';

  const amount = payload.receivedAmount ?? payload.amount;
  const symbol = payload.receivedAmount ? (payload.receivedSymbol ?? payload.symbol) : payload.symbol;

  return (
    <ActivityRow
      icon={
        failed ? (
          <Icon name={IconName.Close} className="w-5 h-5" fill="currentColor" />
        ) : (
          <Icon name={IconName.Download} className="w-5 h-5" fill="currentColor" />
        )
      }
      iconBg={failed ? 'bg-status-negative' : 'bg-tx-received'}
      title={
        failed ? t('notificationBridgeInEpochFailedTitle') : t('notificationBridgeInEpochTitle', { amount, symbol })
      }
      subtitle={failed ? payload.error : t('notificationVia', { provider: 'epoch' })}
      timestamp={relativeTime(notification.createdAt)}
      onClick={() => onNavigate('/history')}
    />
  );
};
