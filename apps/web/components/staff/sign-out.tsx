'use client';

import { useState } from 'react';
import { discard, flush, listQueued } from '@/lib/outbox';
import { useStaff } from '@/lib/staff';
import { ConfirmDialog } from '@/components/ui/overlay';
import { useOutboxState } from './outbox-panel';

/**
 * Signing out revokes this session, so changes still waiting on this device would be lost: try to
 * send them first, and ask before dropping any that cannot go. Render `dialog` once on the page.
 */
export function useSignOut() {
  const { logout, token } = useStaff();
  const { pending } = useOutboxState();
  const [unsynced, setUnsynced] = useState(false);

  const signOut = async () => {
    if (pending > 0) {
      await flush(token);
      if ((await listQueued()).length > 0) return setUnsynced(true);
    }
    await logout();
  };
  const signOutAnyway = async () => {
    for (const q of await listQueued()) await discard(q.key);
    await logout();
  };
  const dialog = (
    <ConfirmDialog
      open={unsynced}
      onClose={() => setUnsynced(false)}
      title="Changes not sent yet"
      description={`${pending} change${pending === 1 ? ' is' : 's are'} saved on this device but could not reach the server. Stay signed in until the internet is back, or sign out and lose ${pending === 1 ? 'it' : 'them'}.`}
      confirmLabel="Sign out anyway"
      onConfirm={() => void signOutAnyway()}
    />
  );
  return { signOut, dialog };
}
