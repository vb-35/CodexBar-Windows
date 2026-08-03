import React from 'react';
import { getProviderSectionVisibility } from '../../shared/popover-model';
import { ProviderUsageData } from '../hooks/useUsageData';
import { ResetCountdown } from './ResetCountdown';
import { UsageProgressBar } from './UsageProgressBar';

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
          <div className="sheet-meta">
            <span>{formatUpdatedAt(data.updatedAt)}</span>
            <span>{accountKindLabel}</span>
          </div>
        </div>
        <div className="provider-header-side">
          <div className="provider-identity">{accountLabel}</div>
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

      {visibility.showHistory && localHistory && (
        <HistorySection title="Token Usage (local logs)" history={localHistory} />
      )}

      {visibility.showHistory && remoteHistory && (
        <HistorySection title="Token Usage (remote logs)" history={remoteHistory} />
      )}

      {visibility.showCredits && data.credits && (
        <div className="sheet-section">
          <div className="section-heading">Credits</div>
          <UsageProgressBar
            percent={data.credits.unlimited ? 100 : 0}
            label=""
            thresholds={[]}
            isRemaining
            leftLabel={data.credits.unlimited ? 'Unlimited' : '$0 left'}
            rightLabel={data.credits.unlimited ? '' : `$${data.credits.remaining.toFixed(2)} available`}
          />
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
        <StatCell label="Yesterday" value={formatTokens(history.yesterday.tokensUsed)} secondary={formatCost(history.yesterday.estimatedCostUSD)} align="right" />
        <StatCell label="This week" value={formatTokens(history.week.tokensUsed)} secondary={formatCost(history.week.estimatedCostUSD)} />
        <StatCell label="Last 30 days" value={formatTokens(history.month30.tokensUsed)} secondary={formatCost(history.month30.estimatedCostUSD)} align="right" />
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
      <div className="section-heading">{title}</div>
      <UsageProgressBar percent={percent} thresholds={[20, 50]} isRemaining />
      <div className="section-details">
        <div className="section-detail-strong">{detailLeft}</div>
        <div className="section-detail-strong section-detail-strong--right">
          <ResetCountdown resetAt={resetAt} label={detailRight} />
        </div>
      </div>
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
  if (!timestamp) return 'Waiting for refresh';
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return 'Updated just now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `Updated ${diffMinutes}m ago`;
  return `Updated ${Math.floor(diffMinutes / 60)}h ago`;
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
