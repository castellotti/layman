import { useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import type { PendingApprovalDTO } from '../lib/types.js';

export function usePendingApprovals(): {
  approvals: PendingApprovalDTO[];
  count: number;
  oldest: PendingApprovalDTO | null;
} {
  const pendingApprovals = useSessionStore((state) => state.pendingApprovals);

  const approvals = useMemo(
    () =>
      Array.from(pendingApprovals.values())
        .filter((a) => a.eventName !== 'PermissionRequest')
        .sort((a, b) => a.timestamp - b.timestamp),
    [pendingApprovals]
  );

  return {
    approvals,
    count: approvals.length,
    oldest: approvals[0] ?? null,
  };
}
