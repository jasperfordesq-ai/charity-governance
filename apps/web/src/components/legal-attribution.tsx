export const SOURCE_REPOSITORY_URL = 'https://github.com/jasperfordesq-ai/charity-governance';

export function LegalAttribution({ className = '' }: { className?: string }) {
  return (
    <p className={className}>
      CharityPilot copyright (C) 2026 Jasper Ford, IP holder. Licensed under
      {' '}
      GPL-3.0-or-later. Source:
      {' '}
      <a
        href={SOURCE_REPOSITORY_URL}
        target="_blank"
        rel="noreferrer"
        className="font-medium underline decoration-current/40 underline-offset-4 transition-colors hover:text-teal-primary dark:hover:text-teal-bright"
      >
        GitHub repository
      </a>
      .
    </p>
  );
}
