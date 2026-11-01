// Contact page. mailto: only, per the approved design spec — explicitly
// no backend contact-submission form/workflow.
//
// Real, confirmed COY21 contact details (COY21 Delegates Handbook,
// sections 2.4 "Emergency Contacts" and 2.5 "Useful Contacts") —
// replaces the earlier placeholder single mailbox left over from an
// older, unrelated project's contact list (Madad for Development, Foras
// Khadra, Arab Youth Summit for Climate Action), none of which are
// COY21 organizers.
import { useTranslations } from 'next-intl';
import { Reveal } from '@/components/motion/reveal';
import { Blob } from '@/components/motion/blob';
import { SocialLinks } from '@/components/public/social-links';

const ORGANIZER_EMAILS = [
  { nameKey: 'delegateQuestionsName', email: 'liaisons@climatecoy.com', accent: 'turquoise' },
  { nameKey: 'generalName', email: 'admin@climatecoy.com', accent: 'green' },
  { nameKey: 'partnershipsName', email: 'youngo.unfccc@gmail.com', accent: 'gold' },
] as const;

// Handbook section 2.4: save before you travel, in case of an emergency
// at the venue. Phone numbers given directly by the user from the
// handbook, not invented.
const EMERGENCY_CONTACTS = [
  { nameKey: 'emergencyInternational', name: 'Nibras', phone: '+1 647 624 8404' },
  { nameKey: 'emergencyLocal', name: 'Alia Sherif', phone: '+90 535 795 2072' },
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

      <Reveal delayMs={240} className="mt-10 border-t border-charcoal/10 pt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-charcoal/50">{t('emergencyHeading')}</h2>
        <p className="mt-2 text-sm text-charcoal/70">{t('emergencyIntro')}</p>
        <div className="mt-4 flex flex-col gap-2">
          {EMERGENCY_CONTACTS.map((contact) => (
            <div key={contact.phone} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium text-charcoal">{t(contact.nameKey)}:</span>
              <span className="text-charcoal/80">{contact.name}</span>
              <a href={`tel:${contact.phone.replace(/\s/g, '')}`} className="text-turquoise underline underline-offset-4 hover:text-turquoise/80">
                {contact.phone}
              </a>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal delayMs={320} className="mt-10 border-t border-charcoal/10 pt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-charcoal/50">{t('followUsHeading')}</h2>
        <SocialLinks showNames className="mt-4 flex flex-col gap-3" />
      </Reveal>
    </div>
  );
}
