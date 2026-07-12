export const SOURCE_REPOSITORY_URL = 'https://github.com/jasperfordesq-ai/charity-governance';

export function LegalAttribution({ className = '' }: { className?: string }) {
  return (
    <p className={className}>
      Powered by CharityPilot. Created by Jasper Ford. Contributor: hOUR Timebank CLG
      {' '}
      (Ireland). Licensed under
      {' '}
      AGPL-3.0-or-later. Source:
      {' '}
      <a
        href={SOURCE_REPOSITORY_URL}
        target="_blank"
        rel="noreferrer"
        className="font-medium underline decoration-current/40 underline-offset-4 transition-colors hover:text-teal-primary dark:hover:text-teal-bright"
      >
        GitHub repository
      </a>
      . No warranty.
    </p>
  );
}
