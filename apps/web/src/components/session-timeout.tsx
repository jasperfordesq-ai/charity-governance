'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody } from '@heroui/react';
import { ModalFormActions } from '@/components/ui/modal-form-actions';
import { api } from '@/lib/api';
import { Clock } from 'lucide-react';

const SESSION_TIMEOUT = 14 * 60 * 1000; // 14 minutes (token lasts 15m)
const WARNING_BEFORE = 2 * 60 * 1000;   // Show warning 2 min before

export function SessionTimeout() {
  const [showWarning, setShowWarning] = useState(false);
  const [countdown, setCountdown] = useState(120);
  const [isExtending, setIsExtending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors showWarning for the activity listener so the main effect does not
  // need showWarning as a dependency (which made it tear down its own countdown
  // the moment the warning appeared, so it never counted down or logged out).
  const showWarningRef = useRef(false);

  const resetTimer = useCallback(() => {
    setShowWarning(false);
    showWarningRef.current = false;
    setCountdown(120);
    if (timer.current) clearTimeout(timer.current);
    if (countdownRef.current) clearInterval(countdownRef.current);

    timer.current = setTimeout(() => {
      setShowWarning(true);
      showWarningRef.current = true;
      setCountdown(120);
      countdownRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            // Session expired - redirect to login.
            void api.post('/auth/logout', {}).catch(() => undefined);
            window.location.href = '/login';
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }, SESSION_TIMEOUT - WARNING_BEFORE);
  }, []);

  useEffect(() => {
    resetTimer();

    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    const handleActivity = () => {
      if (!showWarningRef.current) resetTimer();
    };

    events.forEach((e) => window.addEventListener(e, handleActivity, { passive: true }));
    return () => {
      events.forEach((e) => window.removeEventListener(e, handleActivity));
      if (timer.current) clearTimeout(timer.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [resetTimer]);

  const handleExtend = async () => {
    setIsExtending(true);
    try {
      await api.post('/auth/refresh', {});
    } catch {
      // If refresh fails, redirect
      window.location.href = '/login';
      return;
    } finally {
      setIsExtending(false);
    }
    resetTimer();
  };

  const handleSignOut = async () => {
    await api.post('/auth/logout', {}).catch(() => undefined);
    window.location.href = '/login';
  };

  if (!showWarning) return null;

  return (
    <Modal isOpen={showWarning} onOpenChange={() => {}} isDismissable={false} size="sm">
      <ModalContent>
        <ModalHeader>Session Expiring Soon</ModalHeader>
        <ModalBody>
          <div className="text-center" role="status" aria-live="polite">
            <div className="w-16 h-16 rounded-lg bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center mx-auto mb-4">
              <Clock className="w-8 h-8 text-amber-500 dark:text-amber-300" strokeWidth={1.5} aria-hidden="true" />
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
              Your session will expire in
            </p>
            <p className="text-3xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
              {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              Click below to stay signed in, or you will be redirected to the login page.
            </p>
          </div>
        </ModalBody>
        <ModalFormActions
          cancelLabel="Sign out"
          submitLabel="Stay signed in"
          onCancel={handleSignOut}
          onSubmit={handleExtend}
          submitting={isExtending}
        />
      </ModalContent>
    </Modal>
  );
}
