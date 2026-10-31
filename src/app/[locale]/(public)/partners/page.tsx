import { useTranslations } from 'next-intl';
import { Reveal } from '@/components/motion/reveal';
import { Blob } from '@/components/motion/blob';

// Replaced 2026-11-01 with the real COY21 sponsor/co-host list (previous
// placeholder "Türkiye Coalition" / "Australia Coalition" entries removed
// entirely, including their now-unused /public/partners/*.svg files).
const SPONSORED_BY = [
  { name: 'British Council', slug: 'british-council' },
  { name: 'IOM UN Migration', slug: 'iom' },
  { name: 'UNICEF', slug: 'unicef' },
  { name: 'UN Women', slug: 'un-women' },
  { name: 'SANKO', slug: 'sanko' },
  { name: 'UNDP', slug: 'undp' },
];

const CO_HOSTED_BY = [
  { name: 'Esmiyor.', slug: 'esmiyor' },
  { name: 'İklim Elçileri', slug: 'iklim-elcileri' },
  { name: 'Genç Enerji Derneği', slug: 'genc-enerji' },
  { name: 'Sosyal İklim', slug: 'sosyal-iklim' },
  { name: 'Ecomind', slug: 'ecomind' },
  { name: 'Habitat', slug: 'habitat' },
  { name: 'Climate and Health Alliance (CAHA)', slug: 'caha' },
];

function PartnerCard({ name, slug }: { name: string; slug: string }) {
  return (
    // bg-turquoise (the brand's navy-blue token, see globals.css) instead of
    // white: every partner logo is a white-on-transparent SVG, which is
    // invisible against a white card -- the navy background is what makes
    // the white logo artwork visible.
    <div className="flex h-28 items-center justify-center rounded-xl border border-charcoal/10 bg-turquoise p-4 shadow-sm transition-shadow duration-200 hover:shadow-md">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/partners/${slug}.svg`}
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
        <h2 className="font-[family-name:var(--font-thmanyah)] text-xl font-semibold text-charcoal">
          Sponsored by
        </h2>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {SPONSORED_BY.map((p) => (
            <PartnerCard key={p.slug} name={p.name} slug={p.slug} />
          ))}
        </div>
      </Reveal>

      <Reveal delayMs={100} className="mt-10">
        <h2 className="font-[family-name:var(--font-thmanyah)] text-xl font-semibold text-charcoal">
          Co-Hosted by
        </h2>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {CO_HOSTED_BY.map((p) => (
            <PartnerCard key={p.slug} name={p.name} slug={p.slug} />
          ))}
        </div>
      </Reveal>
    </div>
  );
}
