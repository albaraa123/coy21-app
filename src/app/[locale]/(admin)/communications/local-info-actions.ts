'use server';

import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { isStaffRole } from '@/lib/auth/is-staff-role';

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' as const, user: null };
  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  // 2026-09-29 staff role consolidation: was a hand-rolled
  // ['super_admin', 'participants_communications_manager'].includes(...)
  // check — participants_communications_manager no longer exists as an
  // assignable role (migrated to 'staff'), so this was silently locking
  // out every staff account until fixed. See
  // docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md.
  if (!profile || !isStaffRole(profile.role)) {
    return { error: 'Not authorized' as const, user: null };
  }
  return { error: null, user };
}

// ─── Sections ──────────────────────────────────────────────────────────────

const SectionSchema = z.object({ title: z.string().min(1).max(100) });

export async function createSection(formData: FormData) {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error };

  const parsed = SectionSchema.safeParse({ title: formData.get('title') });
  if (!parsed.success) return { error: 'Invalid title' };

  const service = createServiceRoleClient();
  const { data: last } = await service
    .from('local_info_sections')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .single();

  const { error } = await service.from('local_info_sections').insert({
    title: parsed.data.title,
    sort_order: (last?.sort_order ?? 0) + 1,
  });

  if (error) return { error: error.message };
  revalidatePath('/en/communications');
  return { error: null };
}

export async function updateSection(id: string, formData: FormData) {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error };

  const parsed = SectionSchema.safeParse({ title: formData.get('title') });
  if (!parsed.success) return { error: 'Invalid title' };

  const service = createServiceRoleClient();
  const { error } = await service
    .from('local_info_sections')
    .update({ title: parsed.data.title, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return { error: error.message };
  revalidatePath('/en/communications');
  return { error: null };
}

export async function deleteSection(id: string) {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error };

  const service = createServiceRoleClient();
  const { error } = await service.from('local_info_sections').delete().eq('id', id);

  if (error) return { error: error.message };
  revalidatePath('/en/communications');
  return { error: null };
}

export async function toggleSectionActive(id: string, isActive: boolean) {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error };

  const service = createServiceRoleClient();
  const { error } = await service
    .from('local_info_sections')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return { error: error.message };
  revalidatePath('/en/communications');
  return { error: null };
}

// ─── Items ──────────────────────────────────────────────────────────────────

const ItemSchema = z.object({
  section_id: z.string().uuid(),
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(1000),
});

export async function createItem(formData: FormData) {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error };

  const parsed = ItemSchema.safeParse({
    section_id: formData.get('section_id'),
    label: formData.get('label'),
    value: formData.get('value'),
  });
  if (!parsed.success) return { error: 'Invalid item data' };

  const service = createServiceRoleClient();
  const { data: last } = await service
    .from('local_info_items')
    .select('sort_order')
    .eq('section_id', parsed.data.section_id)
    .order('sort_order', { ascending: false })
    .limit(1)
    .single();

  const { error } = await service.from('local_info_items').insert({
    ...parsed.data,
    sort_order: (last?.sort_order ?? 0) + 1,
  });

  if (error) return { error: error.message };
  revalidatePath('/en/communications');
  return { error: null };
}

export async function updateItem(id: string, formData: FormData) {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error };

  const parsed = z.object({
    label: z.string().min(1).max(200),
    value: z.string().min(1).max(1000),
  }).safeParse({
    label: formData.get('label'),
    value: formData.get('value'),
  });
  if (!parsed.success) return { error: 'Invalid item data' };

  const service = createServiceRoleClient();
  const { error } = await service.from('local_info_items').update(parsed.data).eq('id', id);

  if (error) return { error: error.message };
  revalidatePath('/en/communications');
  return { error: null };
}

export async function deleteItem(id: string) {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error };

  const service = createServiceRoleClient();
  const { error } = await service.from('local_info_items').delete().eq('id', id);

  if (error) return { error: error.message };
  revalidatePath('/en/communications');
  return { error: null };
}

// ─── Images ─────────────────────────────────────────────────────────────────

export async function deleteImage(id: string) {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error };

  const service = createServiceRoleClient();
  const { data: img } = await service.from('local_info_images').select('storage_url').eq('id', id).single();

  if (img?.storage_url) {
    // Extract path from URL: .../storage/v1/object/public/local-info/<path>
    const match = img.storage_url.match(/\/local-info\/(.+)$/);
    if (match?.[1]) {
      await service.storage.from('local-info').remove([match[1]]);
    }
  }

  const { error } = await service.from('local_info_images').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/en/communications');
  return { error: null };
}

export async function uploadImage(formData: FormData) {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error };

  const file = formData.get('file') as File | null;
  const sectionId = formData.get('section_id') as string | null;
  const caption = (formData.get('caption') as string | null) ?? '';

  if (!file || file.size === 0) return { error: 'No file provided' };
  if (file.size > 5 * 1024 * 1024) return { error: 'File too large (max 5 MB)' };

  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
  const path = `${sectionId ?? 'general'}/${Date.now()}.${ext}`;

  const service = createServiceRoleClient();
  const { error: uploadError } = await service.storage
    .from('local-info')
    .upload(path, file, { upsert: false, contentType: file.type });

  if (uploadError) return { error: uploadError.message };

  const { data: { publicUrl } } = service.storage.from('local-info').getPublicUrl(path);

  const { data: last } = await service
    .from('local_info_images')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .single();

  const { error } = await service.from('local_info_images').insert({
    section_id: sectionId || null,
    caption: caption || null,
    storage_url: publicUrl,
    sort_order: (last?.sort_order ?? 0) + 1,
  });

  if (error) return { error: error.message };
  revalidatePath('/en/communications');
  return { error: null };
}
