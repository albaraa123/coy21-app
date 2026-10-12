// src/app/api/cron/dispatch-all/route.ts
//
// Single external-cron entry point that runs the 4 fast-cadence cron
// routes (process-notifications, session-reminders,
// process-session-notifications, process-session-no-shows) in one HTTP
// call, so a single free-tier external scheduler job (one job, one
// request per minute) can drive all of them -- Vercel's own Hobby-plan
// cron only allows once-daily scheduling, and the free external cron
// service this project uses (cron-job.org) turned out to allow only one
// job per account, not the 4 originally planned. travel-reminders stays
// on its own, separate, once-daily Vercel-scheduled cron
// (vercel.json) -- it doesn't need minute-level cadence and already fits
// the Hobby plan's native cron on its own.
//
// Each sub-route's GET handler is called DIRECTLY (function call, not an
// HTTP round-trip back into this same deployment) with the identical
// incoming NextRequest, so every route's own CRON_SECRET/Authorization
// check still runs exactly as before -- this file adds no new trust
// boundary, it only triggers the same 4 handlers together instead of
// requiring 4 separate external schedules. The sub-routes are otherwise
// completely unmodified: this file imports and calls their existing
// exported GET functions, it does not duplicate or reimplement any of
// their logic.
//
// Runs all 4 sequentially (not Promise.all): each sub-route already does
// its own internal batching/locking for concurrency SAFETY WITHIN itself
// (e.g. process-notifications' row-claiming), but nothing coordinates
// resource contention ACROSS routes if they ran concurrently against the
// same database at the same moment. Sequential execution removes that
// unknown entirely; the combined work across all 4 routes' existing
// per-route BATCH_SIZE caps is small enough that running them one after
// another well within typical serverless function time limits.
//
// One sub-route throwing or returning a non-ok response must not prevent
// the remaining 3 from running -- each call is independently try/caught
// and its outcome recorded, never aborting the loop.
import { NextRequest, NextResponse } from 'next/server';
import { GET as processNotifications } from '../process-notifications/route';
import { GET as sessionReminders } from '../session-reminders/route';
import { GET as processSessionNotifications } from '../process-session-notifications/route';
import { GET as processSessionNoShows } from '../process-session-no-shows/route';

const SUB_ROUTES: Array<{ name: string; handler: (req: NextRequest) => Promise<Response> }> = [
  { name: 'process-notifications', handler: processNotifications },
  { name: 'session-reminders', handler: sessionReminders },
  { name: 'process-session-notifications', handler: processSessionNotifications },
  { name: 'process-session-no-shows', handler: processSessionNoShows },
];

type SubRouteResult = {
  name: string;
  ok: boolean;
  status: number | null;
  body?: unknown;
  error?: string;
};

export async function GET(req: NextRequest) {
  const results: SubRouteResult[] = [];

  for (const { name, handler } of SUB_ROUTES) {
    try {
      const response = await handler(req);
      let body: unknown = null;
      try {
        body = await response.clone().json();
      } catch {
        // Non-JSON response body (e.g. a plain "Forbidden" text response
        // from a failed auth check inside the sub-route) -- not an error
        // in THIS dispatcher, just nothing structured to report back.
      }
      results.push({ name, ok: response.ok, status: response.status, body });
    } catch (err) {
      // A sub-route throwing (not returning a handled error response) must
      // not stop the remaining routes from running.
      console.error('dispatch-all: sub-route threw', { name, error: err });
      results.push({
        name,
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  const anyFailed = results.some((r) => !r.ok);
  return NextResponse.json({ results }, { status: anyFailed ? 207 : 200 });
}
