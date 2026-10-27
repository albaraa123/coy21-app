// tests/cafeteria/schema-live.test.ts
//
// Task 1: live schema/constraint tests for the new cafeteria_credentials
// table (see docs/superpowers/specs/2026-10-27-cafeteria-lunch-qr-design.md).
// Follows this codebase's established live-test convention: service-role
// admin client against the real Supabase project.
//
// No afterAll/fixture cleanup here: both test inserts below are expected
// to be REJECTED by the cafeteria_credentials_one_owner CHECK constraint,
// so no row ever actually persists. Later tasks in this plan (concurrency,
// eligibility) will insert real rows and DO need an afterAll — don't
// assume this file's lack of one was an oversight when copying it as a
// template.
import { describe, it, expect, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// Live round trips to the real Supabase project routinely exceed Vitest's
// 5000ms default in this codebase (see tests/attendance/notifications-schema-live.test.ts
// and others for the same fix).
vi.setConfig({ testTimeout: 30000 });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

describe('cafeteria schema', () => {
  it('cafeteria_credentials rejects a row with both application_id and profile_id set', async () => {
    const { error } = await admin.from('cafeteria_credentials').insert({
      application_id: '00000000-0000-0000-0000-000000000000',
      profile_id: '00000000-0000-0000-0000-000000000000',
      token_hash: Buffer.alloc(32, 1) as unknown as never,
      qr_image_data_uri: 'data:image/png;base64,TEST',
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/cafeteria_credentials_one_owner|violates/i);
  });

  it('cafeteria_credentials rejects a row with neither set', async () => {
    const { error } = await admin.from('cafeteria_credentials').insert({
      token_hash: Buffer.alloc(32, 2) as unknown as never,
      qr_image_data_uri: 'data:image/png;base64,TEST',
    });
    expect(error).not.toBeNull();
  });
});
