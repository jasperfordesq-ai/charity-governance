'use client';

import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function handleScroll() {
      setVisible(window.scrollY > 400);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className="fixed bottom-6 right-6 z-50 w-10 h-10 rounded-full bg-teal-primary text-white shadow-lg hover:bg-teal-dark dark:hover:bg-teal-light transition-all flex items-center justify-center opacity-80 hover:opacity-100"
      aria-label="Back to top"
    >
      <ArrowUp className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
