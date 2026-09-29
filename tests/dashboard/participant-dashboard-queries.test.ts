// tests/dashboard/participant-dashboard-queries.test.ts
//
// Mocked-service unit coverage for getMyTravelCompleteness (Task 7 of the
// participant-portal-ux plan). Mirrors the two-step-lookup shape already
// established by getMySchedulePublicationState in the same source file:
// first the caller's own `applications.id` via `applicant_id = userId`,
// then a second, dependent query against `application_travel_info` scoped
// to that `application_id`. Because the real function makes TWO sequential
// `.from()` calls against two different tables, each test below wires
// `service.from` with `mockImplementation` that branches on the table name
// — not a single generic `mockReturnValue` — so each call is verifiably
// answering its own table, not accidentally reusing the other's response.
import { describe, it, expect, vi } from 'vitest';
import { getMyTravelCompleteness } from '@/lib/dashboard/participant-dashboard-queries';

describe('getMyTravelCompleteness', () => {
  it('returns { kind: "empty" } when the caller has no applications row at all (never claimed/submitted)', async () => {
    const applicationsMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const travelInfoMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });

    const service = {
      from: vi.fn((table: string) => {
        if (table === 'applications') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: applicationsMaybeSingle };
        }
        if (table === 'application_travel_info') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: travelInfoMaybeSingle };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const result = await getMyTravelCompleteness({ userId: 'user-1', service: service as never });

    expect(result).toEqual({ kind: 'empty' });
    expect(applicationsMaybeSingle).toHaveBeenCalledTimes(1);
    // The second (application_travel_info) query must never run once the
    // first lookup finds no applications row — there is no application_id
    // to scope it to.
    expect(travelInfoMaybeSingle).not.toHaveBeenCalled();
  });

  it('returns { kind: "data", value: { submitted: false } } when the application exists but no travel_info row does', async () => {
    const applicationsMaybeSingle = vi.fn().mockResolvedValue({ data: { id: 'app-1' }, error: null });
    const travelInfoMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });

    const service = {
      from: vi.fn((table: string) => {
        if (table === 'applications') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: applicationsMaybeSingle };
        }
        if (table === 'application_travel_info') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: travelInfoMaybeSingle };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const result = await getMyTravelCompleteness({ userId: 'user-1', service: service as never });

    expect(result).toEqual({ kind: 'data', value: { submitted: false } });
    expect(applicationsMaybeSingle).toHaveBeenCalledTimes(1);
    expect(travelInfoMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('returns { kind: "data", value: { submitted: true } } when an application_travel_info row exists', async () => {
    const applicationsMaybeSingle = vi.fn().mockResolvedValue({ data: { id: 'app-1' }, error: null });
    const travelInfoMaybeSingle = vi.fn().mockResolvedValue({ data: { application_id: 'app-1' }, error: null });

    const service = {
      from: vi.fn((table: string) => {
        if (table === 'applications') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: applicationsMaybeSingle };
        }
        if (table === 'application_travel_info') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: travelInfoMaybeSingle };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const result = await getMyTravelCompleteness({ userId: 'user-1', service: service as never });

    expect(result).toEqual({ kind: 'data', value: { submitted: true } });
    expect(applicationsMaybeSingle).toHaveBeenCalledTimes(1);
    expect(travelInfoMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('returns { kind: "error" } when the applications lookup itself fails', async () => {
    const applicationsMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const travelInfoMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });

    const service = {
      from: vi.fn((table: string) => {
        if (table === 'applications') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: applicationsMaybeSingle };
        }
        if (table === 'application_travel_info') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: travelInfoMaybeSingle };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const result = await getMyTravelCompleteness({ userId: 'user-1', service: service as never });

    expect(result).toEqual({ kind: 'error', message: 'boom' });
    expect(travelInfoMaybeSingle).not.toHaveBeenCalled();
  });

  it('returns { kind: "error" } when the travel_info lookup itself fails', async () => {
    const applicationsMaybeSingle = vi.fn().mockResolvedValue({ data: { id: 'app-1' }, error: null });
    const travelInfoMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom-2' } });

    const service = {
      from: vi.fn((table: string) => {
        if (table === 'applications') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: applicationsMaybeSingle };
        }
        if (table === 'application_travel_info') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: travelInfoMaybeSingle };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const result = await getMyTravelCompleteness({ userId: 'user-1', service: service as never });

    expect(result).toEqual({ kind: 'error', message: 'boom-2' });
  });
});
