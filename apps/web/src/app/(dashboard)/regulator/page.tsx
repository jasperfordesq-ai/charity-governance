'use client';

import Link from 'next/link';
import { Button, Card, Chip } from '@heroui/react';
import { useDocumentTitle } from '@/lib/use-title';
import {
  evidencePackItems,
  officialGuidanceLinks,
  productAuditMap,
  regulatorOperatingModel,
} from '@/lib/regulator-guidance';

export default function RegulatorGuidePage() {
  useDocumentTitle('Regulator Guide');

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-teal-primary/20 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <Chip size="sm" variant="flat" className="mb-3 bg-teal-primary/10 text-teal-primary">
              Irish charities governance
            </Chip>
            <h1 className="text-3xl font-bold text-gray-950">Regulator Readiness Map</h1>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              A working map of what CharityPilot needs to cover for Irish charity trustees:
              Governance Code evidence, Annual Report timing, trustee duties, financial controls,
              fundraising practice, conflicts, risk, and the 2024 Act change watch.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button as={Link} href="/compliance" className="bg-teal-primary text-white hover:bg-teal-dark">
              Open Compliance
            </Button>
            <Button as={Link} href="/documents" variant="flat">
              Evidence Vault
            </Button>
            <Button as={Link} href="/export" variant="flat">
              Export Pack
            </Button>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        {regulatorOperatingModel.map((item) => (
          <Card key={item.title} className="rounded-lg border border-gray-200 p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-primary">{item.cadence}</p>
            <h2 className="mt-2 text-base font-semibold text-gray-900">{item.title}</h2>
            <p className="mt-2 text-xs font-medium text-gray-500">{item.owner}</p>
            <p className="mt-3 text-sm leading-6 text-gray-600">{item.evidence}</p>
          </Card>
        ))}
      </section>

      <section>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Evidence Pack</h2>
            <p className="text-sm text-gray-500">
              The practical file set the board should be able to find before signing off the annual compliance position.
            </p>
          </div>
          <Button as={Link} href="/documents" size="sm" variant="flat">
            Upload evidence
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {evidencePackItems.map((item) => (
            <Card key={item.title} className="rounded-lg border border-gray-200 p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-semibold text-gray-900">{item.title}</h3>
                <Chip size="sm" variant="flat" className="font-mono">
                  {item.category.replace(/_/g, ' ')}
                </Chip>
              </div>
              <p className="mt-2 text-xs font-medium text-teal-primary">Standards {item.standards}</p>
              <p className="mt-2 text-sm leading-6 text-gray-600">{item.why}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-4">
          <h2 className="text-xl font-bold text-gray-900">Product Audit</h2>
          <p className="text-sm text-gray-500">
            Where the day-one app is already useful, and where the next build should go deeper.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {productAuditMap.map((item) => (
            <Card key={item.area} className="rounded-lg border border-gray-200 p-5 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-gray-900">{item.area}</h3>
                <Chip
                  size="sm"
                  variant="flat"
                  color={item.status === 'Missing' || item.status === 'Thin' ? 'warning' : 'primary'}
                >
                  {item.status}
                </Chip>
              </div>
              <p className="mt-3 text-sm leading-6 text-gray-600">{item.now}</p>
              <p className="mt-2 text-sm leading-6 text-gray-800">
                <span className="font-semibold">Next:</span> {item.next}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-4">
          <h2 className="text-xl font-bold text-gray-900">Official Guidance</h2>
          <p className="text-sm text-gray-500">
            Primary sources to keep beside product decisions and board workflows.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {officialGuidanceLinks.map((item) => (
            <a
              key={item.href}
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-teal-primary/50"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-semibold text-gray-900">{item.title}</h3>
                <span className="text-xs font-semibold text-teal-primary">Open</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-gray-600">{item.note}</p>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
