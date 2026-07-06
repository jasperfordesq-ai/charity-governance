'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { Check, CircleAlert, Info } from 'lucide-react';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  toast: (message: string, type?: Toast['type']) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let toastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: Toast['type'] = 'success') => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed inset-x-4 bottom-4 z-[200] flex flex-col items-end gap-2 pointer-events-none sm:left-auto sm:right-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            aria-live={t.type === 'error' ? 'assertive' : 'polite'}
            className={`
              pointer-events-auto w-full max-w-[calc(100vw-2rem)] rounded-lg border px-4 py-3 shadow-lg text-sm font-medium
              animate-[slideIn_0.2s_ease-out]
              sm:w-auto sm:max-w-sm
              ${t.type === 'success' ? 'border-green-200 bg-white text-green-900 dark:border-green-800 dark:bg-gray-900 dark:text-green-100' : ''}
              ${t.type === 'error' ? 'border-red-200 bg-white text-red-900 dark:border-red-800 dark:bg-gray-900 dark:text-red-100' : ''}
              ${t.type === 'info' ? 'border-gray-200 bg-white text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100' : ''}
            `}
          >
            <div className="flex items-start gap-2">
              {t.type === 'success' && (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-300" strokeWidth={2.5} aria-hidden="true" />
              )}
              {t.type === 'error' && (
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" strokeWidth={2} aria-hidden="true" />
              )}
              {t.type === 'info' && (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-500 dark:text-gray-300" strokeWidth={2} aria-hidden="true" />
              )}
              <span className="min-w-0 break-words">{t.message}</span>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
