'use client';

import { AppShell } from '@/components/staff/shell';
import { ApprovalProvider } from '@/components/staff/approval';
import { I18nProvider } from '@/lib/i18n';
import { RealtimeProvider } from '@/lib/realtime';
import { StaffProvider, useStaff } from '@/lib/staff';

function Realtime({ children }: { children: React.ReactNode }) {
  const { token, outletId } = useStaff();
  return (
    <RealtimeProvider token={token} outletId={outletId}>
      {children}
    </RealtimeProvider>
  );
}

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaffProvider>
      <I18nProvider storageKey="dineos.staff.lang">
        <Realtime>
          <ApprovalProvider>
            <AppShell>{children}</AppShell>
          </ApprovalProvider>
        </Realtime>
      </I18nProvider>
    </StaffProvider>
  );
}
