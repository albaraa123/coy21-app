import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import en from '@/messages/en.json';

/**
 * Bilingual 404 UI. For inline usage inside a locale-scoped route (where
 * `useTranslations` has a real NextIntlClientProvider ancestor), the default
 * mode renders fully translated copy for the active locale.
 *
 * `static` mode renders the default locale's ("ar", per src/i18n/routing.ts)
 * copy directly from the message JSON, with no `useTranslations` call and no
 * dependency on route params. This exists because Next's `not-found.tsx`
 * file-convention component receives no props at all in this Next version
 * (confirmed in node_modules/next/dist/docs/01-app/.../not-found.md) — so a
 * root/locale-scoped not-found.tsx file cannot know which locale to render
 * and must use this fallback. See Task 6 for where this gets wired in.
 */
export function NotFoundState({ static: isStatic = false }: { static?: boolean } = {}) {
  if (isStatic) {
    const copy = en.states.notFound;
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
        <h2 className="text-lg font-medium text-charcoal dark:text-gray-100">{copy.title}</h2>
        <p className="text-sm text-charcoal/70 dark:text-gray-400">{copy.description}</p>
        <div className="mt-2">
          <Link href="/" className="text-sm font-medium text-turquoise underline">
            {copy.homeLabel}
          </Link>
        </div>
      </div>
    );
  }

  return <NotFoundStateTranslated />;
}

function NotFoundStateTranslated() {
  const t = useTranslations('states.notFound');
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
      <h2 className="text-lg font-medium text-charcoal dark:text-gray-100">{t('title')}</h2>
      <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('description')}</p>
      <div className="mt-2">
        <Link href="/" className="text-sm font-medium text-turquoise underline">
          {t('homeLabel')}
        </Link>
      </div>
    </div>
  );
}
