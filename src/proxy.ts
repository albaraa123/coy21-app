import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { NextRequest } from 'next/server';

// Next.js 16 renamed the `middleware` file convention to `proxy`
// (see node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// next-intl 4.13's `createMiddleware` still returns a plain
// `(request: NextRequest) => NextResponse` handler, which is exactly the
// shape the `proxy` export expects, so it is reused here unchanged.
const intlMiddleware = createMiddleware(routing);

// (admin)/layout.tsx needs the real request pathname to decide whether a
// `staff` caller is allowed on this route (see isRouteAllowedForStaff),
// but Next.js Server Component layouts never receive pathname as a prop.
// Forwarding it via a request header here -- the one place that does see
// the real URL before render -- avoids adding a second Supabase auth
// round-trip to every matched request (which a middleware-side auth
// check would require); the layout already fetches profile.role itself.
//
// Confirmed against this project's exact Next.js 16.2.11 docs
// (proxy.md's "Setting Headers" section): only
// NextResponse.next({ request: { headers } }) makes a header visible to
// Server Components -- plain request.headers.set(...) does not
// propagate, and NextResponse.next({ headers }) sets a response header
// visible to the client instead. But next-intl's own createMiddleware
// (confirmed by reading its compiled source, v4.13.3) always returns its
// OWN NextResponse (next/rewrite/redirect, chosen internally) -- so
// re-wrapping its result in a second NextResponse.next({...}) here would
// silently discard a real locale redirect/rewrite. Fix: build a NEW
// NextRequest carrying the extra header, and pass THAT into
// intlMiddleware, so whichever response next-intl produces is already
// built from a request that has the header -- no post-hoc merging.
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  // IMPORTANT: do NOT build this via `new NextRequest(request.url, { ...request, headers: requestHeaders })`.
  // That spread looks plausible but is a real, silent bug: Request/NextRequest
  // instances keep their real state (method, body, etc.) behind
  // non-enumerable internals, not own-enumerable properties, so `...request`
  // in an object literal copies NOTHING. Confirmed empirically against this
  // project's actual installed `next/server` module (Node REPL): building a
  // POST NextRequest that way silently produces a GET. Since this app's
  // Server Actions ride as POST requests to ordinary page routes (which this
  // proxy's matcher does cover, per proxy.md's own "Server Functions are not
  // separate routes" note), that bug would silently break every Server
  // Action submission in the app.
  //
  // The construction below IS verified empirically to work (Node REPL
  // against this project's real next/server, including method, body,
  // headers, cookies, and query string all surviving correctly):
  // `new Request(request, { headers })` is the standard Request clone-with-
  // overrides constructor (WHATWG-specified to copy method/body/etc.,
  // unlike spreading), then `new NextRequest(...)` on the result restores
  // the Next-specific nextUrl/cookies API that intlMiddleware needs.
  const clonedRequest = new Request(request, { headers: requestHeaders });
  const requestWithPathname = new NextRequest(clonedRequest);
  return intlMiddleware(requestWithPathname);
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
