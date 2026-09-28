// Speakers page (Phase 9.2) — now a real, database-backed page. Shows
// exactly the people staff have explicitly opted in via people.is_public
// (see src/lib/content/public-speakers.ts's own header comment for the
// full eligibility rule and why service-role + a narrow allowlist was
// chosen over a new RLS policy). Falls back to the same EmptyState as
// before when zero speakers are currently public — this is a normal,
// expected state (e.g. before any speakers are confirmed), not an error.
import { getLocale, getTranslations } from 'next-intl/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getPublicSpeakers } from '@/lib/content/public-speakers';
import { EmptyState } from '@/components/ui/empty-state';
import { Reveal } from '@/components/motion/reveal';
import { Blob } from '@/components/motion/blob';
import { Parallax } from '@/components/motion/parallax';

export default async function SpeakersPage() {
  const locale = await getLocale();
  const t = await getTranslations('public');

  const service = createServiceRoleClient();
  const speakers = await getPublicSpeakers(service);

  return (
    <>
      {/* HERO — gradient band matching the other public pages, instead of
          a plain stacked title. */}
      <section className="relative overflow-hidden border-b border-charcoal/10">
        <div
          aria-hidden="true"
          className="animate-gradient-drift absolute inset-0 -z-10"
          style={{
            backgroundImage:
              'linear-gradient(120deg, color-mix(in srgb, var(--color-gold) 16%, var(--color-warm-white)) 0%, color-mix(in srgb, var(--color-turquoise) 14%, var(--color-warm-white)) 100%)',
          }}
        />
        <Parallax strength={0.06}>
          <Blob color="gold" className="right-[-8%] top-[-10%] h-64 w-64" />
        </Parallax>
        <div data-reveal="visible" className="mx-auto max-w-3xl px-4 py-16 text-center md:py-20">
          <h1 className="font-[family-name:var(--font-thmanyah)] text-3xl font-semibold text-charcoal md:text-4xl">
            {t('pages.speakers.title')}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-charcoal/80">{t('pages.speakers.intro')}</p>
        </div>
      </section>

      {speakers.length === 0 ? (
        <div className="mx-auto max-w-3xl px-4 py-16">
          <EmptyState title={t('comingSoon.title')} description={t('comingSoon.description')} />
        </div>
      ) : (
        <div className="mx-auto max-w-5xl px-4 py-16">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
          {speakers.map((speaker, index) => {
            const name = locale === 'ar' ? speaker.fullNameAr : speaker.fullNameEn;
            const role = locale === 'ar' ? speaker.titleAr : speaker.titleEn;
            const organization = locale === 'ar' ? speaker.organizationAr : speaker.organizationEn;
            const bio = locale === 'ar' ? speaker.bioAr : speaker.bioEn;
            const accents = ['var(--color-turquoise)', 'var(--color-green)', 'var(--color-gold)'];
            const accent = accents[index % accents.length];
            return (
              <Reveal key={speaker.id} delayMs={(index % 3) * 80}>
                <div
                  className="flex h-full flex-col items-center gap-2 rounded-lg border border-t-4 border-charcoal/10 p-4 text-center shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-md"
                  style={{ borderTopColor: accent }}
                >
                  {speaker.photoPath ? (
                    // eslint-disable-next-line @next/next/no-img-element -- photoPath is staff-entered free text (not necessarily a Next-optimizable local/remote asset), same as every other admin-entered photo reference in this codebase (rooms/tracks have none; this is the first).
                    <img src={speaker.photoPath} alt={name} className="h-24 w-24 rounded-full object-cover" />
                  ) : (
                    <div aria-hidden="true" className="h-24 w-24 rounded-full bg-charcoal/10" />
                  )}
                  <p className="text-base font-semibold text-charcoal">{name}</p>
                  {role && <p className="text-sm text-charcoal/70">{role}</p>}
                  {organization && <p className="text-sm text-charcoal/60">{organization}</p>}
                  {bio && <p className="mt-1 text-sm text-charcoal/80">{bio}</p>}
                </div>
              </Reveal>
            );
          })}
        </div>
        </div>
      )}
    </>
  );
}
