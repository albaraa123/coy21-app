// FAQ page (Task 9, expanded). Genuine, sensible Q&A copy about the
// conference — not Lorem Ipsum, and no invented specific facts (price,
// dates) that haven't been confirmed. Uses a minimal hand-built
// accessible accordion (src/components/public/faq-accordion.tsx) since
// no accordion primitive exists in package.json.
//
// The 8 questions + 4 "why join" reasons below were supplied directly by
// the user (source: a set of real, published Instagram-carousel graphics
// for RCOY MENA), not invented — including the venue correction that the
// conference is held at the Oman Across Ages Museum in the Wilayat of
// Manah, not Muscat.
import { useTranslations } from 'next-intl';
import { FaqAccordion, type FaqEntry } from '@/components/public/faq-accordion';
import { Reveal } from '@/components/motion/reveal';
import { Blob } from '@/components/motion/blob';

export default function FaqPage() {
  const t = useTranslations('public.pages.faq');

  const entries: FaqEntry[] = [
    { id: 'q1', question: t('q1question'), answer: t('q1answer') },
    { id: 'q2', question: t('q2question'), answer: t('q2answer') },
    { id: 'q3', question: t('q3question'), answer: t('q3answer') },
    { id: 'q4', question: t('q4question'), answer: t('q4answer') },
    { id: 'q5', question: t('q5question'), answer: t('q5answer') },
    { id: 'q6', question: t('q6question'), answer: t('q6answer') },
    { id: 'q7', question: t('q7question'), answer: t('q7answer') },
    { id: 'q8', question: t('q8question'), answer: t('q8answer') },
  ];

  const whyReasons = [
    { titleKey: 'why1Title', bodyKey: 'why1Body', accent: 'turquoise' },
    { titleKey: 'why2Title', bodyKey: 'why2Body', accent: 'green' },
    { titleKey: 'why3Title', bodyKey: 'why3Body', accent: 'gold' },
    { titleKey: 'why4Title', bodyKey: 'why4Body', accent: 'turquoise' },
  ] as const;

  return (
    <>
      <div className="relative mx-auto max-w-3xl overflow-hidden px-4 py-16">
        <Blob color="turquoise" className="right-[-10%] top-[-6%] h-56 w-56" />
        <div data-reveal="visible">
          <h1 className="font-[family-name:var(--font-thmanyah)] text-3xl font-semibold text-charcoal">
            {t('title')}
          </h1>
          <p className="mt-4 text-lg text-charcoal/80">{t('intro')}</p>
        </div>

        <Reveal
          className="mt-6 rounded-lg border border-t-4 border-charcoal/10 bg-warm-white p-4"
          style={{ borderTopColor: 'var(--color-gold)' }}
        >
          <p className="text-sm leading-relaxed text-charcoal/80">{t('venueNote')}</p>
        </Reveal>

        <Reveal className="mt-8">
          <FaqAccordion entries={entries} />
        </Reveal>
      </div>

      {/* "Why join" — a full-bleed dark band, mirroring the About page's
          organizer showcase, so this genuinely persuasive content reads
          as a distinct highlight rather than more accordion rows. */}
      <section className="relative overflow-hidden bg-charcoal py-16 dark:bg-black">
        <div
          aria-hidden="true"
          className="animate-gradient-drift absolute inset-0 -z-10 opacity-40"
          style={{
            backgroundImage:
              'radial-gradient(circle at 15% 20%, color-mix(in srgb, var(--color-turquoise) 30%, transparent) 0%, transparent 50%), radial-gradient(circle at 85% 80%, color-mix(in srgb, var(--color-gold) 28%, transparent) 0%, transparent 50%)',
          }}
        />
        <Reveal className="mx-auto max-w-3xl px-4 text-center">
          <h2 className="font-[family-name:var(--font-thmanyah)] text-2xl font-semibold text-white">
            {t('whyJoinTitle')}
          </h2>
        </Reveal>
        <div className="mx-auto mt-10 grid max-w-5xl gap-5 px-4 sm:grid-cols-2">
          {whyReasons.map((reason, i) => (
            <Reveal key={reason.titleKey} delayMs={i * 100}>
              <div
                className="flex h-full flex-col gap-2 rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:bg-white/10"
                style={{ borderInlineStartWidth: '4px', borderInlineStartColor: `var(--color-${reason.accent})` }}
              >
                <span
                  className="text-2xl font-bold"
                  style={{ color: `var(--color-${reason.accent})` }}
                  aria-hidden="true"
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="text-base font-semibold text-white">{t(reason.titleKey)}</h3>
                <p className="text-sm leading-relaxed text-warm-white/75">{t(reason.bodyKey)}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

    </>
  );
}
