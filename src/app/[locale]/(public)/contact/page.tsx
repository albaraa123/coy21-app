// Contact page (Task 9). mailto: only, per the approved design spec —
// explicitly no backend contact-submission form/workflow.
//
// No dedicated RCOY MENA mailbox exists yet, so this points to the two
// real, confirmed organizer mailboxes instead of a fabricated
// info@rcoymena.org placeholder (per direct user instruction: use Madad
// for Development's and Foras Khadra's actual inboxes since there is no
// event-specific address yet).
import { useTranslations } from 'next-intl';
import { Reveal } from '@/components/motion/reveal';
import { Blob } from '@/components/motion/blob';
import { SocialLinks } from '@/components/public/social-links';

const ORGANIZER_EMAILS = [
  { nameKey: 'madadName', email: 'youngo.unfccc@gmail.com', accent: 'turquoise' },
] as const;

export default function ContactPage() {
  const t = useTranslations('public.pages.contact');

  return (
    <div className="relative mx-auto max-w-3xl overflow-hidden px-4 py-16">
      <Blob color="green" className="right-[-10%] top-[-6%] h-56 w-56" />
      <div data-reveal="visible">
        <h1 className="font-[family-name:var(--font-thmanyah)] text-3xl font-semibold text-charcoal">
          {t('title')}
        </h1>
        <p className="mt-4 text-lg text-charcoal/80">{t('intro')}</p>
      </div>

      <div className="mt-8 flex flex-col gap-4">
        {ORGANIZER_EMAILS.map((org, i) => (
          <Reveal
            key={org.email}
            delayMs={i * 80}
            className="rounded-lg border border-t-4 border-charcoal/10 bg-warm-white p-6 transition-shadow duration-200 hover:shadow-md"
            style={{ borderTopColor: `var(--color-${org.accent})` }}
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-charcoal/50">{t(org.nameKey)}</p>
            <a
              href={`mailto:${org.email}`}
              className="mt-1 inline-block text-lg font-medium text-turquoise underline underline-offset-4 hover:text-turquoise/80"
            >
              <span className="sr-only">{t('actionLabel')}: </span>
              {org.email}
            </a>
          </Reveal>
        ))}
      </div>

      <Reveal delayMs={160} className="mt-10 border-t border-charcoal/10 pt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-charcoal/50">{t('followUsHeading')}</h2>
        <SocialLinks showNames className="mt-4 flex flex-col gap-3" />
      </Reveal>
    </div>
  );
}
