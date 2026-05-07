'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from '@heroui/react';
import { api } from '@/lib/api';

const SESSION_TIMEOUT = 14 * 60 * 1000; // 14 minutes (token lasts 15m)
const WARNING_BEFORE = 2 * 60 * 1000;   // Show warning 2 min before

export function SessionTimeout() {
  const [showWarning, setShowWarning] = useState(false);
  const [countdown, setCountdown] = useState(120);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const resetTimer = useCallback(() => {
    setShowWarning(false);
    setCountdown(120);
    if (timer.current) clearTimeout(timer.current);
    if (countdownRef.current) clearInterval(countdownRef.current);

    timer.current = setTimeout(() => {
      setShowWarning(true);
      setCountdown(120);
      countdownRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            // Session expired — redirect to login
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
      if (!showWarning) resetTimer();
    };

    events.forEach((e) => window.addEventListener(e, handleActivity, { passive: true }));
    return () => {
      events.forEach((e) => window.removeEventListener(e, handleActivity));
      if (timer.current) clearTimeout(timer.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [resetTimer, showWarning]);

  const handleExtend = async () => {
    try {
      await api.post('/auth/refresh', {});
    } catch {
      // If refresh fails, redirect
      window.location.href = '/login';
      return;
    }
    resetTimer();
  };

  if (!showWarning) return null;

  return (
    <Modal isOpen={showWarning} onOpenChange={() => {}} isDismissable={false} size="sm">
      <ModalContent>
        <ModalHeader>Session Expiring Soon</ModalHeader>
        <ModalBody>
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
              Your session will expire in
            </p>
            <p className="text-3xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
              {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
            </p>
            <p className="text-xs text-gray-400 mt-2">
              Click below to stay signed in, or you will be redirected to the login page.
            </p>
          </div>
        </ModalBody>
        <ModalFooter className="justify-center">
          <Button
            className="bg-teal-primary text-white font-semibold"
            onPress={handleExtend}
            radius="full"
          >
            Stay signed in
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
