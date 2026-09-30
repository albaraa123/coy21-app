// tests/import/invitation.test.ts
//
// Mocked unit coverage for Task 9 (design doc): sendInvitation and
// resendInvitation must refuse to call Supabase Auth's inviteUserByEmail
// while sandbox mode is enabled — that channel's email body cannot be
// redirected/prefixed to the sandbox recipient like the other 5 send paths
// covered in Task 2, so invitations are blocked outright instead.
//
// No live Supabase project is used here (unlike tests/import/invitation-live.test.ts).
// fetchEmailSettings is mocked the same way tests/email/resend-send.test.ts
// mocks it, so this suite never constructs a real service-role client via
// createServiceRoleClient() and never makes a real network call.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchEmailSettingsMock } = vi.hoisted(() => ({ fetchEmailSettingsMock: vi.fn() }));

vi.mock('@/lib/email/send-guarded', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send-guarded')>();
  return {
    ...actual,
    fetchEmailSettings: fetchEmailSettingsMock,
  };
});

// findExistingAuthUserByEmail is exercised in full below (sandbox-disabled
// cases must still cover sendInvitation's existing-user collision check),
// so it is not mocked — instead the fake service client's
// auth.admin.listUsers is wired to back it, matching its own pagination
// contract (see src/lib/auth/find-user-by-email.ts).
import { sendInvitation, resendInvitation } from '@/lib/import/invitation';

const inviteUserByEmailMock = vi.fn();
const listUsersMock = vi.fn();

function makeService(overrides: {
  application?: { id: string; imported_email: string | null; applicant_id: string | null } | null;
  applicationError?: unknown;
  existingInvitation?: { status: string; resend_count: number; imported_email: string; invited_user_id: string | null } | null;
  existingInvitationError?: unknown;
}) {
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  const updateEqMock = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn(() => ({ eq: updateEqMock }));

  const from = vi.fn((table: string) => {
    if (table === 'applications') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: overrides.application ?? null,
              error: overrides.applicationError ?? null,
            }),
          }),
        }),
      };
    }
    if (table === 'participant_invitations') {
      return {
        upsert: upsertMock,
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: overrides.existingInvitation ?? null,
              error: overrides.existingInvitationError ?? null,
            }),
          }),
        }),
        update: updateMock,
      };
    }
    throw new Error(`unexpected table in test mock: ${table}`);
  });

  const service = {
    from,
    auth: {
      admin: {
        inviteUserByEmail: inviteUserByEmailMock,
        listUsers: listUsersMock,
      },
    },
  };

  return { service, upsertMock, updateMock, updateEqMock };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no existing Auth users, so findExistingAuthUserByEmail's
  // pagination loop terminates on the first (short) page.
  listUsersMock.mockResolvedValue({ data: { users: [] }, error: null });
});

describe('sendInvitation — sandbox mode guard (Task 9)', () => {
  it('blocks the invitation and never calls inviteUserByEmail when sandbox is enabled', async () => {
    fetchEmailSettingsMock.mockResolvedValue({ sandboxEnabled: true, sandboxRecipientEmail: 'sandbox@example.com' });
    const { service, upsertMock } = makeService({
      application: { id: 'app-1', imported_email: 'participant@example.com', applicant_id: null },
    });

    await expect(sendInvitation(service as never, 'app-1', 'actor-1')).rejects.toThrow(
      'Invitations are disabled while sandbox mode is enabled.'
    );

    expect(inviteUserByEmailMock).not.toHaveBeenCalled();
    // The guard runs before any DB write, so the participant_invitations
    // upsert (which the real inviteUserByEmail call site depends on for
    // status tracking) must not have been reached either.
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('sends normally when sandbox is disabled (existing behavior unchanged)', async () => {
    fetchEmailSettingsMock.mockResolvedValue({ sandboxEnabled: false, sandboxRecipientEmail: null });
    const { service, upsertMock } = makeService({
      application: { id: 'app-1', imported_email: 'participant@example.com', applicant_id: null },
    });
    inviteUserByEmailMock.mockResolvedValue({ data: { user: { id: 'invited-user-1' } }, error: null });

    const result = await sendInvitation(service as never, 'app-1', 'actor-1');

    expect(result).toEqual({ invitedUserId: 'invited-user-1' });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(inviteUserByEmailMock).toHaveBeenCalledTimes(1);
    expect(inviteUserByEmailMock).toHaveBeenCalledWith(
      'participant@example.com',
      expect.objectContaining({ redirectTo: expect.stringContaining('/claim') })
    );
  });
});

describe('resendInvitation — sandbox mode guard (Task 9)', () => {
  it('blocks the resend and never calls inviteUserByEmail when sandbox is enabled', async () => {
    fetchEmailSettingsMock.mockResolvedValue({ sandboxEnabled: true, sandboxRecipientEmail: 'sandbox@example.com' });
    const { service, updateMock } = makeService({
      existingInvitation: {
        status: 'sent',
        resend_count: 0,
        imported_email: 'participant@example.com',
        invited_user_id: 'invited-user-1',
      },
    });

    await expect(resendInvitation(service as never, 'app-1')).rejects.toThrow(
      'Invitations are disabled while sandbox mode is enabled.'
    );

    expect(inviteUserByEmailMock).not.toHaveBeenCalled();
    // Guard runs before the status-row read/update path too.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('resends normally when sandbox is disabled (existing behavior unchanged)', async () => {
    fetchEmailSettingsMock.mockResolvedValue({ sandboxEnabled: false, sandboxRecipientEmail: null });
    const { service, updateMock, updateEqMock } = makeService({
      existingInvitation: {
        status: 'sent',
        resend_count: 1,
        imported_email: 'participant@example.com',
        invited_user_id: 'invited-user-1',
      },
    });
    inviteUserByEmailMock.mockResolvedValue({ data: { user: { id: 'invited-user-1' } }, error: null });

    const result = await resendInvitation(service as never, 'app-1');

    expect(result).toEqual({ invitedUserId: 'invited-user-1' });
    expect(inviteUserByEmailMock).toHaveBeenCalledTimes(1);
    expect(inviteUserByEmailMock).toHaveBeenCalledWith(
      'participant@example.com',
      expect.objectContaining({ redirectTo: expect.stringContaining('/claim') })
    );
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateEqMock).toHaveBeenCalledWith('application_id', 'app-1');
  });
});
