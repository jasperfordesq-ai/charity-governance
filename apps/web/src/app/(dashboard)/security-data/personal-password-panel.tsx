'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Input } from '@heroui/react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';
import { resetPasswordIssue } from '@/lib/form-schemas';
import { AppSection } from '@/components/ui/app-page';

export function PersonalPasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [secondFactor, setSecondFactor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordIssue = newPassword ? resetPasswordIssue(newPassword) : null;
  const canSubmit = !!currentPassword && !!newPassword && !passwordIssue &&
    newPassword === confirmPassword && currentPassword !== newPassword;

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const offered = secondFactor.trim();
      await api.post('/auth/change-password', {
        currentPassword, newPassword,
        ...(offered ? /^\d{6}$/.test(offered) ? { code: offered } : { recoveryCode: offered } : {}),
      }, { skipAuthRefresh: true, skipAuthRedirect: true });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSecondFactor('');
      window.location.assign('/login');
    } catch (err) {
      setError(apiErrorMessage(err, 'Your password could not be changed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppSection title="Your password">
      <div className="space-y-3 text-sm">
        <p className="text-gray-600 dark:text-gray-300">Change your password here. If two-step sign-in is on, enter a current authenticator code or unused recovery code. All sessions end when the change succeeds.</p>
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        <Input type="password" label="Current password" value={currentPassword} onValueChange={setCurrentPassword} autoComplete="current-password" />
        <Input type="password" label="New password" value={newPassword} onValueChange={setNewPassword} autoComplete="new-password" isInvalid={!!passwordIssue} errorMessage={passwordIssue ?? undefined} />
        <Input type="password" label="Confirm new password" value={confirmPassword} onValueChange={setConfirmPassword} autoComplete="new-password" isInvalid={!!confirmPassword && confirmPassword !== newPassword} errorMessage={confirmPassword && confirmPassword !== newPassword ? 'Passwords do not match.' : undefined} />
        <Input type="password" label="Authenticator or recovery code, if enabled" value={secondFactor} onValueChange={setSecondFactor} autoComplete="one-time-code" />
        <Button isDisabled={!canSubmit} isLoading={busy} onPress={() => void submit()}>Change password and sign out</Button>
        <p className="text-gray-600 dark:text-gray-300">Forgot your current password? <Link className="font-medium text-teal-primary underline underline-offset-2" href="/forgot-password">Open password recovery</Link>.</p>
      </div>
    </AppSection>
  );
}
