import { useEffect } from 'react';

/** Sets document.title on mount, resets on unmount */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} — CharityPilot`;
    return () => { document.title = prev; };
  }, [title]);
}
