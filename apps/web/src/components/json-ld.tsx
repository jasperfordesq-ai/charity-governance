export function OrganisationJsonLd() {
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
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export function BlogPostJsonLd({
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
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export function FaqJsonLd({ faqs }: { faqs: Array<{ question: string; answer: string }> }) {
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
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
