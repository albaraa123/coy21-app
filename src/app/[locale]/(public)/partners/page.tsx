import { useTranslations } from 'next-intl';
import { Reveal } from '@/components/motion/reveal';
import { Blob } from '@/components/motion/blob';

const TURKIYE_COALITION = [
  { name: 'Youth for Good', slug: 'youth-for-good' },
  { name: 'European Youth Energy Network', slug: 'eyen' },
];

const AUSTRALIA_COALITION = [
  { name: 'Climate CATCH Lab', slug: 'climate-catch-lab' },
  { name: 'Orygen', slug: 'orygen' },
  { name: 'Climate Writers', slug: 'climate-writers' },
  { name: 'Australian Youth for International Climate Engagement (AYFICE)', slug: 'ayfice' },
  { name: 'Oceania Youth Climate Negotiation Network (OYCNN)', slug: 'oycnn' },
];

function PartnerCard({ name, slug }: { name: string; slug: string }) {
  return (
    <div className="flex h-28 items-center justify-center rounded-xl border border-charcoal/10 bg-white p-4 shadow-sm transition-shadow duration-200 hover:shadow-md">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/partners/${slug}.png`}
        alt={name}
        className="h-16 w-auto max-w-full object-contain"
      />
    </div>
  );
}

export default function PartnersPage() {
  const t = useTranslations('public');

  return (
    <div className="relative mx-auto max-w-4xl px-4 py-16">
      <Blob color="gold" className="right-[-10%] top-[-6%] h-56 w-56" />
      <div data-reveal="visible">
        <h1 className="font-[family-name:var(--font-thmanyah)] text-3xl font-semibold text-charcoal">
          {t('pages.partners.title')}
        </h1>
        <p className="mt-4 text-lg text-charcoal/80">{t('pages.partners.intro')}</p>
      </div>

      <Reveal className="mt-12">
        <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-charcoal/40">
          Co-Host Coalition
        </p>
        <h2 className="font-[family-name:var(--font-thmanyah)] text-xl font-semibold text-charcoal">
          Türkiye Coalition
        </h2>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {TURKIYE_COALITION.map((p) => (
            <PartnerCard key={p.slug} name={p.name} slug={p.slug} />
          ))}
        </div>
      </Reveal>

      <Reveal delayMs={100} className="mt-10">
        <h2 className="font-[family-name:var(--font-thmanyah)] text-xl font-semibold text-charcoal">
          Australia Coalition
        </h2>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {AUSTRALIA_COALITION.map((p) => (
            <PartnerCard key={p.slug} name={p.name} slug={p.slug} />
          ))}
        </div>
      </Reveal>
    </div>
  );
}
