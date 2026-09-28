// About page (Task 9). Real, honest, general copy about what RCOY MENA
// is — no fabricated specific facts, dates, or numbers. Queries nothing
// from the database; this is static, translated copy only.
//
// SECOND DESIGN PASS — matches the homepage's recomposition: every
// section below has a different shape (asymmetric split, offset
// two-column, giant pull-quote-style numerals, alternating rows)
// instead of the original flat stack of identical Cards. RTL-safe via
// natural grid/document flow (no hardcoded left/right) and CSS logical
// properties (borderInlineStartColor) where a directional accent is used.
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/motion/reveal';
import { Blob } from '@/components/motion/blob';
import { Parallax } from '@/components/motion/parallax';

export default function AboutPage() {
  const t = useTranslations('public.pages.about');

  return (
    <>
    {/* HERO — asymmetric split with the real brand mark, mirroring the
        homepage's About section so the two pages feel like one family
        instead of two different design systems. */}
    <section className="relative overflow-hidden border-b border-charcoal/10">
      <Parallax strength={0.06}>
        <Blob color="turquoise" className="right-[-10%] top-[-6%] h-64 w-64" />
      </Parallax>
      <div className="mx-auto grid max-w-5xl grid-cols-1 items-center gap-8 px-4 py-16 md:grid-cols-[1.3fr_1fr] md:py-20">
        <div data-reveal="visible">
          <h1 className="font-[family-name:var(--font-thmanyah)] text-3xl font-semibold leading-tight text-charcoal md:text-4xl">
            {t('title')}
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-charcoal/80">{t('intro')}</p>
        </div>
        <Reveal delayMs={120} className="hidden justify-self-center md:block">
          <div className="relative flex h-56 w-56 items-center justify-center">
            <div
              aria-hidden="true"
              className="absolute inset-0 rounded-full opacity-30 blur-2xl"
              style={{ background: 'linear-gradient(135deg, var(--color-turquoise), var(--color-green), var(--color-gold))' }}
            />
            <Image
              src="/brand/logo/logo-stacked-color.svg"
              alt="COY21 Türkiye 2026"
              width={200}
              height={200}
              className="relative h-auto w-44 drop-shadow-xl"
            />
          </div>
        </Reveal>
      </div>
    </section>

    {/* WHAT / WHO — offset two-column pairing instead of two stacked
        identical cards: each question sits beside its answer, alternating
        which side leads, following natural grid inline-flow so it stays
        correct in RTL. */}
    <section className="mx-auto max-w-4xl px-4 py-16">
      <div className="flex flex-col gap-10">
        <Reveal className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr] md:gap-8">
          <h2 className="font-[family-name:var(--font-thmanyah)] text-xl font-semibold text-charcoal">
            {t('whatTitle')}
          </h2>
          <p className="text-base leading-relaxed text-charcoal/80">{t('whatBody')}</p>
        </Reveal>
        <Reveal delayMs={80} className="grid grid-cols-1 gap-3 border-t border-charcoal/10 pt-10 md:grid-cols-[1fr_2fr] md:gap-8">
          <h2 className="font-[family-name:var(--font-thmanyah)] text-xl font-semibold text-charcoal">
            {t('whoTitle')}
          </h2>
          <p className="text-base leading-relaxed text-charcoal/80">{t('whoBody')}</p>
        </Reveal>
      </div>
    </section>

    {/* VISION / MISSION — large pull-quote-style statements stacked with
        a giant translucent accent glyph, not two equal-height boxes. */}
    <section className="relative overflow-hidden bg-warm-white py-16 dark:bg-gray-950">
      <div className="mx-auto flex max-w-4xl flex-col gap-10 px-4">
        <Reveal className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-6 text-7xl font-bold leading-none opacity-15 rtl:right-0 ltr:left-0"
            style={{ color: 'var(--color-turquoise)' }}
          >
            “
          </span>
          <h2 className="relative font-[family-name:var(--font-thmanyah)] text-2xl font-semibold text-turquoise md:text-3xl">{t('visionTitle')}</h2>
          <p className="relative mt-4 max-w-2xl text-lg leading-relaxed text-charcoal/80">{t('visionBody')}</p>
        </Reveal>
        <Reveal delayMs={100} className="relative border-t border-charcoal/10 pt-10">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-4 text-7xl font-bold leading-none opacity-15 rtl:right-0 ltr:left-0"
            style={{ color: 'var(--color-green)' }}
          >
            “
          </span>
          <h2 className="relative font-[family-name:var(--font-thmanyah)] text-2xl font-semibold text-green md:text-3xl">{t('missionTitle')}</h2>
          <p className="relative mt-4 max-w-2xl text-lg leading-relaxed text-charcoal/80">{t('missionBody')}</p>
        </Reveal>
      </div>
    </section>

    {/* WHY MENA / WHY OMAN — side-by-side split (not stacked cards),
        each half distinguished by an inline-start accent bar rather than
        a full card border, so the pair reads as one continuous argument. */}
    <section className="mx-auto max-w-5xl px-4 py-16">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <Reveal
          className="flex flex-col gap-2 pe-0 ps-5"
          style={{ borderInlineStartWidth: '3px', borderInlineStartColor: 'var(--color-gold)' }}
        >
          <h2 className="text-lg font-semibold text-charcoal">{t('whyMenaTitle')}</h2>
          <p className="text-sm leading-relaxed text-charcoal/80">{t('whyMenaBody')}</p>
        </Reveal>
        <Reveal
          delayMs={100}
          className="flex flex-col gap-2 pe-0 ps-5"
          style={{ borderInlineStartWidth: '3px', borderInlineStartColor: 'var(--color-turquoise)' }}
        >
          <h2 className="text-lg font-semibold text-charcoal">{t('whyOmanTitle')}</h2>
          <p className="text-sm leading-relaxed text-charcoal/80">{t('whyOmanBody')}</p>
        </Reveal>
      </div>
    </section>

    {/* THEMES — alternating offset rows with giant translucent index
        numerals, matching the homepage's THEMES section shape so the two
        pages read as one design language. */}
    <section className="relative overflow-hidden border-t border-charcoal/10 py-20">
      <Parallax strength={-0.05}>
        <Blob color="green" className="left-[-6%] top-[15%] h-64 w-64" />
      </Parallax>
      <Reveal className="mx-auto max-w-3xl px-4 text-center">
        <h2 className="font-[family-name:var(--font-thmanyah)] text-2xl font-semibold text-charcoal">
          {t('themesTitle')}
        </h2>
        <p className="mt-2 text-sm text-charcoal/70">{t('themesIntro')}</p>
      </Reveal>
      <div className="relative mx-auto mt-12 flex max-w-4xl flex-col gap-6 px-4">
        {(['theme1Title', 'theme2Title', 'theme3Title'] as const).map((key, i) => {
          const bodyKey = (['theme1Body', 'theme2Body', 'theme3Body'] as const)[i];
          const accent = (['turquoise', 'green', 'gold'] as const)[i];
          const align = i % 2 === 0 ? 'md:flex-row' : 'md:flex-row-reverse';
          return (
            <Reveal key={key} delayMs={i * 120}>
              <div className={`group flex flex-col items-start gap-4 border-b border-charcoal/10 pb-6 md:items-center ${align}`}>
                <span
                  aria-hidden="true"
                  className="shrink-0 font-[family-name:var(--font-thmanyah)] text-6xl font-bold leading-none transition-transform duration-300 group-hover:scale-110 md:text-7xl"
                  style={{ color: `var(--color-${accent})`, opacity: 0.4 }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-charcoal md:text-xl">{t(key)}</h3>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-charcoal/70">{t(bodyKey)}</p>
                </div>
              </div>
            </Reveal>
          );
        })}
      </div>
    </section>

    {/* YOUNGO section */}
    <section className="relative overflow-hidden bg-charcoal py-16 text-center dark:bg-black">
      <div
        aria-hidden="true"
        className="animate-gradient-drift absolute inset-0 -z-10 opacity-40"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 30%, color-mix(in srgb, var(--color-turquoise) 35%, transparent) 0%, transparent 50%), radial-gradient(circle at 80% 70%, color-mix(in srgb, var(--color-gold) 30%, transparent) 0%, transparent 50%)',
        }}
      />
      <Reveal className="mx-auto max-w-3xl px-4">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-warm-white/60">
          {t('ayscEyebrow')}
        </p>
        <h2 className="mt-3 font-[family-name:var(--font-thmanyah)] text-2xl font-semibold text-white">
          {t('ayscTitle')}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-warm-white/80">{t('ayscBody')}</p>
      </Reveal>
    </section>

    <div className="mx-auto max-w-3xl px-4 py-16">
      <Reveal>
        <Card>
          <h2 className="text-lg font-semibold text-charcoal">{t('howTitle')}</h2>
          <p className="mt-2 text-sm text-charcoal/80">{t('howBody')}</p>
        </Card>
      </Reveal>
      <div className="mt-6">
        <Button href="/log-in" variant="secondary" className="transition-transform duration-200 hover:-translate-y-0.5">
          {t('ctaLogIn')}
        </Button>
      </div>
    </div>
    </>
  );
}
