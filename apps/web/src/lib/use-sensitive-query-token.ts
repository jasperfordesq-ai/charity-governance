'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getSensitiveUrlToken, removeSensitiveSearchParams } from './url-security';

export function useSensitiveQueryToken(paramName = 'token') {
  const searchParams = useSearchParams();
  const capturedRef = useRef(false);
  const [token, setToken] = useState('');
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (capturedRef.current) return;
    capturedRef.current = true;

    const capturedToken =
      (typeof window !== 'undefined' ? getSensitiveUrlToken(window.location.href, paramName) : '') ||
      searchParams.get(paramName) ||
      '';
    setToken(capturedToken);
    setIsReady(true);

    if (capturedToken && typeof window !== 'undefined') {
      const scrubbedUrl = removeSensitiveSearchParams(window.location.href, [paramName]);
      window.history.replaceState(window.history.state, '', scrubbedUrl);
    }
  }, [paramName, searchParams]);

  return { token, isReady };
}
