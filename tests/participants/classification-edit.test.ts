// tests/participants/classification-edit.test.ts
//
// Unit tests for the shared reclassify-and-reissue helper (spec §3.4).
// Mocks reissueStaffQrCredential and sendClassificationChangeNotificationEmail
// so no real crypto/DB/email work happens — this suite verifies BRANCHING
// logic only (which of the 3 states triggers which side effects), not the
// underlying QR/email mechanics themselves (those are covered by
// qr-credential-issuance's own tests and send-guarded.test.ts respectively).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { reissueStaffQrCredentialMock, sendClassificationChangeNotificationEmailMock } = vi.hoisted(() => ({
  reissueStaffQrCredentialMock: vi.fn(),
  sendClassificationChangeNotificationEmailMock: vi.fn(),
}));

vi.mock('@/lib/attendance/qr-credential-issuance', () => ({
  reissueStaffQrCredential: reissueStaffQrCredentialMock,
}));

vi.mock('@/lib/email/resend', () => ({
  sendClassificationChangeNotificationEmail: sendClassificationChangeNotificationEmailMock,
}));

import { reclassifyApplication } from '@/lib/participants/reclassify';

interface FixtureApplication {
  status: string;
  applicant_id: string | null;
  full_name: string | null;
  profiles: { full_name: string; email: string } | null;
}

function buildService(params: {
  application: FixtureApplication;
  activeCredential: { id: string } | null;
  newApplicationNumber?: string | null;
  numberError?: { message: string } | null;
  updateError?: { message: string } | null;
}) {
  const {
    application,
    activeCredential,
    newApplicationNumber = 'COY21-DEL-0002',
    numberError = null,
    updateError = null,
  } = params;

  const applicationSingle = vi.fn().mockResolvedValue({ data: application, error: null });
  const applicationUpdateEq = vi.fn().mockResolvedValue({ data: null, error: updateError });
  const credentialMaybeSingle = vi.fn().mockResolvedValue({ data: activeCredential, error: null });
  const rpcMock = vi.fn().mockResolvedValue({ data: newApplicationNumber, error: numberError });

  const from = vi.fn((table: string) => {
    if (table === 'applications') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: applicationSingle,
          })),
        })),
        update: vi.fn(() => ({
          eq: applicationUpdateEq,
        })),
      };
    }
    if (table === 'qr_credentials') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: credentialMaybeSingle,
            })),
          })),
        })),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const service = { from, rpc: rpcMock };
  return { service, applicationUpdateEq, credentialMaybeSingle, rpcMock };
}

const requester = {} as never;

beforeEach(() => {
  reissueStaffQrCredentialMock.mockReset();
  sendClassificationChangeNotificationEmailMock.mockReset();
});

describe('reclassifyApplication', () => {
  it('not-yet-accepted application: updates participant_type only, never reissues or emails, application_number untouched', async () => {
    const { service, applicationUpdateEq, rpcMock } = buildService({
      application: { status: 'submitted', applicant_id: 'user-1', full_name: 'Jane Doe', profiles: null },
      activeCredential: null,
    });

    const result = await reclassifyApplication(requester, service as never, {
      applicationId: 'app-1',
      newParticipantType: 'volunteer',
      actorId: 'staff-1',
    });

    expect(result).toEqual({ applicationId: 'app-1', outcome: 'updated_only' });
    expect(applicationUpdateEq).toHaveBeenCalledTimes(1);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(reissueStaffQrCredentialMock).not.toHaveBeenCalled();
    expect(sendClassificationChangeNotificationEmailMock).not.toHaveBeenCalled();
  });

  it('accepted, no active QR credential: regenerates application_number, never reissues, never emails', async () => {
    const { service, rpcMock } = buildService({
      application: { status: 'accepted', applicant_id: 'user-1', full_name: 'Jane Doe', profiles: { full_name: 'Jane Doe', email: 'jane@example.com' } },
      activeCredential: null,
      newApplicationNumber: 'COY21-VOL-0009',
    });

    const result = await reclassifyApplication(requester, service as never, {
      applicationId: 'app-2',
      newParticipantType: 'volunteer',
      actorId: 'staff-1',
    });

    expect(result.outcome).toBe('number_regenerated');
    expect(result.newApplicationNumber).toBe('COY21-VOL-0009');
    expect(result.newApplicationNumber).not.toBe('COY21-DEL-0001');
    expect(rpcMock).toHaveBeenCalledWith('regenerate_application_number', { p_application_id: 'app-2' });
    expect(reissueStaffQrCredentialMock).not.toHaveBeenCalled();
    expect(sendClassificationChangeNotificationEmailMock).not.toHaveBeenCalled();
  });

  it('accepted, active QR credential, applicant_id set (claimed): reissues and sends exactly one email with the new number', async () => {
    reissueStaffQrCredentialMock.mockResolvedValue({ outcome: 'reissued', credentialId: 'cred-new', qrPayload: 'PAYLOAD' });
    sendClassificationChangeNotificationEmailMock.mockResolvedValue({ id: 'email-1', error: null });

    const { service } = buildService({
      application: {
        status: 'accepted',
        applicant_id: 'user-1',
        full_name: 'Jane Doe',
        profiles: { full_name: 'Jane Doe', email: 'jane@example.com' },
      },
      activeCredential: { id: 'cred-old' },
      newApplicationNumber: 'COY21-SPK-0003',
    });

    const result = await reclassifyApplication(requester, service as never, {
      applicationId: 'app-3',
      newParticipantType: 'speaker',
      actorId: 'staff-1',
    });

    expect(result.outcome).toBe('reissued');
    expect(result.newApplicationNumber).toBe('COY21-SPK-0003');

    expect(reissueStaffQrCredentialMock).toHaveBeenCalledTimes(1);
    const reissueCall = reissueStaffQrCredentialMock.mock.calls[0][2];
    expect(reissueCall.applicationId).toBe('app-3');
    expect(reissueCall.expectedCurrentCredentialId).toBe('cred-old');
    expect(reissueCall.reissueReasonCode).toBe('administrative_correction');

    expect(sendClassificationChangeNotificationEmailMock).toHaveBeenCalledTimes(1);
    expect(sendClassificationChangeNotificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'jane@example.com', fullName: 'Jane Doe', newApplicationNumber: 'COY21-SPK-0003' })
    );
  });

  it('accepted, active QR credential, applicant_id null (unclaimed): reissues but never sends an email', async () => {
    reissueStaffQrCredentialMock.mockResolvedValue({ outcome: 'reissued', credentialId: 'cred-new', qrPayload: 'PAYLOAD' });

    const { service } = buildService({
      application: { status: 'accepted', applicant_id: null, full_name: 'Unclaimed Person', profiles: null },
      activeCredential: { id: 'cred-old' },
      newApplicationNumber: 'COY21-YNG-0004',
    });

    const result = await reclassifyApplication(requester, service as never, {
      applicationId: 'app-4',
      newParticipantType: 'youngo',
      actorId: 'staff-1',
    });

    expect(result.outcome).toBe('reissued');
    expect(reissueStaffQrCredentialMock).toHaveBeenCalledTimes(1);
    expect(sendClassificationChangeNotificationEmailMock).not.toHaveBeenCalled();
  });
});
