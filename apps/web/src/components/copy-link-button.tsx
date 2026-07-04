'use client';

import { useState } from 'react';
import { Check, Link2 } from 'lucide-react';

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
        copied
          ? 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300'
          : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
      }`}
      aria-label={copied ? 'Link copied!' : 'Copy link to clipboard'}
      title={copied ? 'Copied!' : 'Copy link'}
    >
      {copied ? (
        <Check className="w-4 h-4" strokeWidth={2.5} aria-hidden="true" />
      ) : (
        <Link2 className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
      )}
    </button>
  );
}
