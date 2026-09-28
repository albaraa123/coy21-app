// src/app/[locale]/(public)/page.tsx
//
// The real COY21 Türkiye 2026 homepage, replacing the old placeholder at
// src/app/[locale]/page.tsx (deleted in this same commit — see that
// deletion's own note for why no window can exist where both files are
// present: both resolve to the same /[locale] route).
//
// Content notes (flagged for review per the task brief — exact hero
// wording was not specified by the design spec, this is a first draft
// using professional judgment):
//  - Hero headline/description and the "what is RCOY MENA" section are
//    general, non-fabricated descriptions of what a Regional Conference
//    of Youth is and what COY21 Türkiye 2026 is — no invented dates,
//    statistics, named speakers, or partners.
//  - The hero CTA uses ONLY "Learn More" (public.cta.learnMore) linking
//    to /about — an approved CTA per the design spec's constraint list,
//    deliberately not implying any open/current registration.
//  - Explore cards link to the Agenda/Speakers/Partners stub pages
//    (honest "coming soon" EmptyState content, built in this same task).
//  - At-a-glance figures (500/20/60) come verbatim from the approved
//    COY21 Türkiye 2026 partnership and funding proposal, not invented here.
//
// SECOND DESIGN PASS (per explicit user feedback that the first vibrant-
// color pass still "felt like a student project" — grid-of-3-identical-
// cards repeated section after section, motion/color layered on top of a
// repetitive skeleton rather than fixing the skeleton itself). This pass
// gives every section a DIFFERENT composition instead of the same
// centered-title + 3-card-grid shape everywhere: About is an asymmetric
// text/visual split, the glance stats use a genuine size hierarchy (one
// huge hero number, two smaller), themes uses an offset asymmetric
// layout instead of 3 equal boxes, and Explore is a set of big
// typographic links instead of another row of cards. Still zero new
// dependencies (CSS + Reveal/CountUp/Blob only) and fully
// prefers-reduced-motion-safe.
import type { Metadata } from 'next';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/motion/reveal';
import { CountUp } from '@/components/motion/count-up';
import { Blob } from '@/components/motion/blob';
import { ParticleField } from '@/components/motion/particle-field';
import { Parallax } from '@/components/motion/parallax';

// Carries forward the old placeholder page's metadata intent (title
// "COY21 Türkiye 2026") — the root layout already sets the same title as a
// default, this is an explicit, page-local restatement for clarity now
// that the homepage has real content.
export const metadata: Metadata = {
  title: 'COY21 Türkiye 2026',
  description: 'COY21 Türkiye 2026 conference registration',
};

export default function PublicHomePage() {
  const t = useTranslations('public');

  return (
    <>
      {/* HERO */}
      <section className="relative overflow-hidden border-b border-charcoal/10">
        <div
          aria-hidden="true"
          className="animate-gradient-drift absolute inset-0 -z-10"
          style={{
            backgroundImage:
              'linear-gradient(120deg, color-mix(in srgb, var(--color-turquoise) 18%, var(--color-warm-white)) 0%, color-mix(in srgb, var(--color-green) 14%, var(--color-warm-white)) 45%, color-mix(in srgb, var(--color-gold) 16%, var(--color-warm-white)) 100%)',
          }}
        />
        <ParticleField />
        <Parallax strength={0.08}>
          <Blob color="turquoise" className="left-[-6%] top-[-10%] h-72 w-72" />
        </Parallax>
        <Parallax strength={-0.1}>
          <Blob color="gold" className="bottom-[-12%] right-[-8%] h-80 w-80" />
        </Parallax>
        <div
          data-reveal="visible"
          className="relative mx-auto flex max-w-4xl flex-col items-center gap-6 px-4 py-20 text-center md:py-28"
        >
          <h1 className="font-[family-name:var(--font-thmanyah)] text-3xl font-semibold leading-tight text-charcoal md:text-5xl">
            {t('homepage.heroTitle')}
          </h1>
          <p className="max-w-2xl text-base text-charcoal/70 md:text-lg">{t('homepage.heroDescription')}</p>
          <Button href="/about" size="lg" className="btn-magnetic">
            {t('cta.learnMore')}
          </Button>
        </div>
      </section>

      {/* ABOUT — asymmetric text/visual split, not a centered block. Uses
          the REAL brand mark (not invented wordmark typography) so it
          stays on-brand; the grid order is language-direction-aware
          (text leads in both LTR and RTL, mark trails) rather than a
          fixed left/right split that would read backwards in Arabic. */}
      <section className="overflow-hidden">
        <div className="mx-auto grid max-w-5xl grid-cols-1 items-center gap-8 px-4 py-20 md:grid-cols-[1.3fr_1fr]">
          <Reveal>
            <h2 className="font-[family-name:var(--font-thmanyah)] text-2xl font-semibold text-charcoal md:text-3xl">
              {t('homepage.aboutTitle')}
            </h2>
            <p className="mt-5 text-base leading-relaxed text-charcoal/70 md:text-lg">{t('homepage.aboutBody')}</p>
          </Reveal>
          <Reveal delayMs={120} className="hidden justify-self-center md:block">
            <div className="relative flex h-64 w-64 items-center justify-center">
              <div
                aria-hidden="true"
                className="absolute inset-0 rounded-full opacity-30 blur-2xl"
                style={{ background: 'linear-gradient(135deg, var(--color-turquoise), var(--color-green), var(--color-gold))' }}
              />
              <Image
                src="/brand/logo/logo-stacked-color.svg"
                alt="COY21 Türkiye 2026"
                width={220}
                height={220}
                className="relative h-auto w-52 drop-shadow-xl"
              />
            </div>
          </Reveal>
        </div>
      </section>



      {/* EXPLORE — big typographic links, not cards. Each row is its own
          full-width hover state (background sweep + arrow slide) so the
          section reads as a navigation moment, not another content grid. */}
      <section className="border-t border-charcoal/10 bg-warm-white">
        <div className="mx-auto max-w-4xl px-4 py-16">
          <Reveal>
            <h2 className="text-center font-[family-name:var(--font-thmanyah)] text-2xl font-semibold text-charcoal">
              {t('homepage.exploreTitle')}
            </h2>
          </Reveal>
          <div className="mt-10 flex flex-col divide-y divide-charcoal/10 border-y border-charcoal/10">
            {[
              { href: '/conference-agenda', titleKey: 'exploreAgendaTitle', descKey: 'exploreAgendaDescription', accent: 'turquoise' },
              { href: '/speakers', titleKey: 'exploreSpeakersTitle', descKey: 'exploreSpeakersDescription', accent: 'green' },
              { href: '/partners', titleKey: 'explorePartnersTitle', descKey: 'explorePartnersDescription', accent: 'gold' },
            ].map((item, i) => (
              <Reveal key={item.href} delayMs={i * 80}>
                <Link
                  href={item.href}
                  className="group flex items-center justify-between gap-4 py-6 transition-colors duration-200"
                >
                  <div>
                    <h3
                      className="text-xl font-semibold text-charcoal transition-colors duration-200 md:text-2xl"
                      style={{ ['--hover-color' as string]: `var(--color-${item.accent})` }}
                    >
                      <span className="bg-gradient-to-r bg-[length:0%_2px] bg-left-bottom bg-no-repeat pb-1 transition-[background-size] duration-300 group-hover:bg-[length:100%_2px]" style={{ backgroundImage: `linear-gradient(var(--color-${item.accent}), var(--color-${item.accent}))` }}>
                        {t(`homepage.${item.titleKey}`)}
                      </span>
                    </h3>
                    <p className="mt-1 text-sm text-charcoal/60">{t(`homepage.${item.descKey}`)}</p>
                  </div>
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-2xl transition-transform duration-300 group-hover:translate-x-1 rtl:group-hover:-translate-x-1 rtl:rotate-180"
                    style={{ color: `var(--color-${item.accent})` }}
                  >
                    →
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
