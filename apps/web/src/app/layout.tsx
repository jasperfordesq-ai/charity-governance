import type { Metadata } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://charitypilot.ie'),
  title: {
    default: 'CharityPilot — Charity Governance Made Simple',
    template: '%s — CharityPilot',
  },
  description:
    'The affordable, Ireland-specific governance compliance tool for registered charities. Track your CRA Charities Governance Code compliance, manage documents, and file with confidence.',
  keywords: [
    'charity governance',
    'CRA compliance',
    'Charities Governance Code',
    'Ireland charity',
    'compliance tracker',
    'registered charity',
    'CharityPilot',
  ],
  alternates: {
    canonical: 'https://charitypilot.ie',
  },
  openGraph: {
    title: 'CharityPilot — Charity Governance Made Simple',
    description:
      'The affordable, Ireland-specific governance compliance tool for registered charities.',
    type: 'website',
    locale: 'en_IE',
    url: 'https://charitypilot.ie',
    siteName: 'CharityPilot',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CharityPilot — Charity Governance Made Simple',
    description: 'The affordable, Ireland-specific governance compliance tool for registered charities.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.ico" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        {/* Prevent FOUC for dark mode */}
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.theme==='dark'||(!('theme' in localStorage)&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}else{document.documentElement.classList.remove('dark')}}catch(e){}` }} />
      </head>
      <body className="font-sans antialiased bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 transition-colors" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
