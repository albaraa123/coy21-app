// src/app/[locale]/(public)/layout.tsx
//
// Public site chrome: header + footer around unauthenticated content. No
// auth check and no redirect here, by design — this route group is
// genuinely public (homepage + the About/Agenda/Speakers/FAQ/Partners/
// Contact/Accessibility/Privacy/Terms stub pages), unlike (admin) and
// (participant), which each gate on profiles.role server-side in their
// own layout.tsx. Adding any auth logic here would be wrong: these pages
// must render identically for a signed-out visitor and a signed-in
// participant/admin who happens to browse to them.
//
// Nests inside the root src/app/[locale]/layout.tsx, which already
// provides <html>/<body>/NextIntlClientProvider — this layout only adds
// the header/main/footer structure within that.
import { PublicHeader } from '@/components/public/public-header';
import { PublicFooter } from '@/components/public/public-footer';
import { ScrollProgress } from '@/components/motion/scroll-progress';
import { PageTransition } from '@/components/motion/page-transition';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-1 flex-col bg-white">
      <ScrollProgress />
      <PublicHeader />
      <main className="flex-1">
        <PageTransition>{children}</PageTransition>
      </main>
      <PublicFooter />
    </div>
  );
}
