import React from 'react';
import { getProviderSectionVisibility } from '../../shared/popover-model';
import { ProviderUsageData } from '../hooks/useUsageData';
import { ResetCountdown } from './ResetCountdown';
import { UsageProgressBar } from './UsageProgressBar';
import { Icon } from './Icon';

interface ProviderCardProps {
  data: ProviderUsageData;
  accountLabel: string;
  accountKindLabel: string;
}

export function ProviderCard({ data, accountLabel, accountKindLabel }: ProviderCardProps) {
  const visibility = getProviderSectionVisibility(data);
  const localHistory = data.history?.local;
  const remoteHistory = data.history?.remote;
  const nextExpiringCredit = data.resetCredits?.credits
    ?.filter((credit) => credit.status === 'available' && credit.expiresAtTimestamp)
    .sort((a, b) => (a.expiresAtTimestamp || 0) - (b.expiresAtTimestamp || 0))[0];

  return (
    <section className={`sheet-card ${data.error ? 'sheet-card--error' : ''}`}>
      <div className="provider-header">
        <div className="provider-header-main">
          <div className="provider-header-title-row">
            <div className="provider-badge" style={{ backgroundColor: data.iconColor }} />
            <div className="sheet-title">{data.displayName}</div>
          </div>
          <div className="sheet-meta" title={`Last updated: ${formatUpdatedAt(data.updatedAt)}`}>
            <Icon name="refresh" size={12} />
            <span>{formatUpdatedAt(data.updatedAt)}</span>
          </div>
        </div>
        <div className="provider-header-side">
          <div className="provider-identity" title={`${accountLabel} (${accountKindLabel})`}>{accountLabel}</div>
          {data.planType && <div className="provider-plan">{data.planType}</div>}
        </div>
      </div>

      {data.error && <div className="sheet-error">{data.error}</div>}

      {visibility.showPrimary && data.primary && (
        <SheetSection
          title={data.primary.label}
          percent={100 - data.primary.usedPercent}
          resetAt={data.primary.resetAt}
          detailLeft={`${Math.round(100 - data.primary.usedPercent)}% left`}
          detailRight={formatResetLabel(data.primary.label)}
        />
      )}

      {visibility.showSecondary && data.secondary && (
        <SheetSection
          title={data.secondary.label}
          percent={100 - data.secondary.usedPercent}
          resetAt={data.secondary.resetAt}
          detailLeft={`${Math.round(100 - data.secondary.usedPercent)}% left`}
          detailRight={formatResetLabel(data.secondary.label)}
        />
      )}

      {visibility.showResetCredits && data.resetCredits && (
        <div className="sheet-section">
          <div className="section-heading">Limit Reset Credits</div>
          <div className="stats-grid">
            <StatCell label="Available" value={`${data.resetCredits.availableCount}`} />
            <StatCell
              label="Next expiry"
              value={nextExpiringCredit?.expiresAtTimestamp ? formatTimeUntil(nextExpiringCredit.expiresAtTimestamp) : 'Unknown'}
              align="right"
            />
          </div>
        </div>
      )}

      {data.additionalWindows?.map((window) => (
        <SheetSection key={window.label} title={window.label} percent={100 - window.usedPercent}
          resetAt={window.resetAt} detailLeft={`${Math.round(100 - window.usedPercent)}% left`} detailRight="Resets in" />
      ))}

      {visibility.showHistory && localHistory && (
        <HistorySection title="Tokens · local" history={localHistory} />
      )}

      {visibility.showHistory && remoteHistory && (
        <HistorySection title="Tokens · remote" history={remoteHistory} />
      )}

      {visibility.showCredits && data.credits && (
        <div className="sheet-section">
          <div className="usage-section-heading">
            <div className="section-heading">Credits</div>
            <div className="section-detail-strong">{data.credits.unlimited ? 'Unlimited' : `$${data.credits.remaining.toFixed(2)} available`}</div>
          </div>
        </div>
      )}

      {!visibility.hasAnyData && (
        <div className="sheet-empty">No usage data available yet.</div>
      )}
    </section>
  );
}

function HistorySection(
  {
    title,
    history,
  }: {
    title: string;
    history: NonNullable<ProviderUsageData['history']>['local'];
  },
) {
  if (!history) return null;

  return (
    <div className="sheet-section">
      <div className="section-heading">{title}</div>
      <div className="stats-grid stats-grid--history">
        <StatCell label="Today" value={formatTokens(history.today.tokensUsed)} secondary={formatCost(history.today.estimatedCostUSD)} />
        <StatCell label="Yesterday" value={formatTokens(history.yesterday.tokensUsed)} secondary={formatCost(history.yesterday.estimatedCostUSD)} />
        <StatCell label="This week" value={formatTokens(history.week.tokensUsed)} secondary={formatCost(history.week.estimatedCostUSD)} />
        <StatCell label="30 days" value={formatTokens(history.month30.tokensUsed)} secondary={formatCost(history.month30.estimatedCostUSD)} />
      </div>
    </div>
  );
}

function SheetSection(
  {
    title,
    percent,
    resetAt,
    detailLeft,
    detailRight,
  }: {
    title: string;
    percent: number;
    resetAt?: number;
    detailLeft: string;
    detailRight: string;
  },
) {
  return (
    <div className="sheet-section">
      <div className="usage-section-heading">
        <div className="section-heading">{title}</div>
        <div className="section-detail-strong">{detailLeft}</div>
        <div className="section-detail-strong section-detail-strong--right">
          <ResetCountdown resetAt={resetAt} label={detailRight} />
        </div>
      </div>
      <UsageProgressBar percent={percent} label={`${title}: ${detailLeft}`} thresholds={[20, 50]} isRemaining hideLabel />
    </div>
  );
}

function StatCell(
  {
    label,
    value,
    secondary,
    align,
  }: {
    label: string;
    value: string;
    secondary?: string;
    align?: 'right';
  },
) {
  return (
    <div className={`stat-cell ${align === 'right' ? 'stat-cell--right' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {secondary && <div className="stat-secondary">{secondary}</div>}
    </div>
  );
}

function formatUpdatedAt(timestamp?: number): string {
  if (!timestamp) return 'Pending';
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return 'Just now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  return `${Math.floor(diffMinutes / 60)}h ago`;
}

function formatResetLabel(label: string): string {
  return label === 'Credits' ? 'Expires in' : 'Resets in';
}

function formatCost(amount: number): string {
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000000) return `${(tokens / 1000000000).toFixed(1)}B`;
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${tokens}`;
}

function formatTimeUntil(timestampSeconds: number): string {
  const diff = Math.max(0, timestampSeconds * 1000 - Date.now());
  const totalHours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor(diff / (1000 * 60)) % 60;
  return `${hours}h ${minutes}m`;
}
