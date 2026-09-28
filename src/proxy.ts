import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

// Next.js 16 renamed the `middleware` file convention to `proxy`
// (see node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// next-intl 4.13's `createMiddleware` still returns a plain
// `(request: NextRequest) => NextResponse` handler, which is exactly the
// shape the `proxy` export expects, so it is reused here unchanged.
export const proxy = createMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
