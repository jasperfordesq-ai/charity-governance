'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, ModalContent, ModalHeader, ModalBody } from '@heroui/react';

const SHORTCUTS = [
  { keys: ['g', 'd'], label: 'Go to Dashboard', href: '/dashboard' },
  { keys: ['g', 'c'], label: 'Go to Compliance', href: '/compliance' },
  { keys: ['g', 'b'], label: 'Go to Board', href: '/board' },
  { keys: ['g', 'o'], label: 'Go to Documents', href: '/documents' },
  { keys: ['g', 'l'], label: 'Go to Deadlines', href: '/deadlines' },
  { keys: ['g', 'e'], label: 'Go to Export', href: '/export' },
  { keys: ['g', 's'], label: 'Go to Organisation', href: '/organisation' },
  { keys: ['?'], label: 'Show keyboard shortcuts', href: '' },
];

export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState('');
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();

      if (key === '?') {
        e.preventDefault();
        setOpen(true);
        return;
      }

      if (key === 'escape') {
        setOpen(false);
        setPending('');
        return;
      }

      if (pending === 'g') {
        const shortcut = SHORTCUTS.find((s) => s.keys.length === 2 && s.keys[1] === key);
        if (shortcut && shortcut.href) {
          e.preventDefault();
          router.push(shortcut.href);
        }
        setPending('');
        return;
      }

      if (key === 'g') {
        setPending('g');
        timer = setTimeout(() => setPending(''), 1000);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [pending, router]);

  return (
    <Modal isOpen={open} onOpenChange={setOpen} size="md">
      <ModalContent>
        <ModalHeader>Keyboard Shortcuts</ModalHeader>
        <ModalBody className="pb-6">
          <div className="space-y-2">
            {SHORTCUTS.map((s) => (
              <div key={s.label} className="flex items-center justify-between py-1.5">
                <span className="text-sm text-gray-600 dark:text-gray-400">{s.label}</span>
                <div className="flex items-center gap-1">
                  {s.keys.map((k, i) => (
                    <span key={i}>
                      {i > 0 && <span className="text-xs text-gray-400 mx-0.5">then</span>}
                      <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded text-xs font-mono font-semibold text-gray-700 dark:text-gray-300">
                        {k === '?' ? '?' : k.toUpperCase()}
                      </kbd>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-3">Press <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 border rounded text-xs">Esc</kbd> to close</p>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
