// tests/cafeteria/schema-live.test.ts
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

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
