import { headers } from 'next/headers';
import { serialiseJsonLdForScript } from '@/lib/json-ld';

async function getNonce() {
  return (await headers()).get('x-nonce') ?? undefined;
}

export async function OrganisationJsonLd() {
  const nonce = await getNonce();
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'CharityPilot',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: 'Governance compliance tool for Irish registered charities. Track CRA Charities Governance Code compliance.',
    url: 'https://charitypilot.ie',
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'EUR',
      lowPrice: '19',
      highPrice: '39',
      offerCount: 2,
    },
    creator: {
      '@type': 'Organization',
      name: 'Project Nexus Ltd',
      address: { '@type': 'PostalAddress', addressLocality: 'Skibbereen', addressCountry: 'IE' },
    },
  };

  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serialiseJsonLdForScript(data) }}
    />
  );
}

export async function BlogPostJsonLd({
  title,
  excerpt,
  date,
  author,
  slug,
}: {
  title: string;
  excerpt: string;
  date: string;
  author: string;
  slug: string;
}) {
  const nonce = await getNonce();
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    description: excerpt,
    datePublished: date,
    author: { '@type': 'Person', name: author },
    publisher: {
      '@type': 'Organization',
      name: 'CharityPilot',
      url: 'https://charitypilot.ie',
    },
    mainEntityOfPage: `https://charitypilot.ie/blog/${slug}`,
  };

  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serialiseJsonLdForScript(data) }}
    />
  );
}

export async function FaqJsonLd({ faqs }: { faqs: Array<{ question: string; answer: string }> }) {
  const nonce = await getNonce();
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };

  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serialiseJsonLdForScript(data) }}
    />
  );
}
