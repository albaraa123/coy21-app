export const dynamic = 'force-dynamic';

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { MapEmbed } from './map-embed';

export default async function LocalInfoPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();

  const [{ data: rawSections }, { data: rawItems }, { data: images }] = await Promise.all([
    service
      .from('local_info_sections')
      .select('id, title, sort_order, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    service
      .from('local_info_items')
      .select('id, section_id, label, value, sort_order')
      .order('sort_order', { ascending: true }),
    service
      .from('local_info_images')
      .select('id, section_id, caption, storage_url, sort_order')
      .order('sort_order', { ascending: true }),
  ]);

  const sections = (rawSections ?? []).map((s) => ({
    ...s,
    local_info_items: (rawItems ?? []).filter((i) => i.section_id === s.id),
  }));

  const imagesBySection = (images ?? []).reduce<Record<string, typeof images>>((acc, img) => {
    if (!img) return acc;
    const key = img.section_id ?? 'general';
    if (!acc[key]) acc[key] = [];
    acc[key]!.push(img);
    return acc;
  }, {});

  const generalImages = imagesBySection['general'] ?? [];

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">Local Info</h1>
        <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">
          Antalya — places, contacts, and essential info for your stay.
        </p>
      </div>

      <MapEmbed />

      {/* General images (not tied to a section) */}
      {generalImages.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {generalImages.map((img) => img && (
              <div key={img.id} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.storage_url} alt={img.caption ?? ''} className="w-full rounded-lg object-cover aspect-video" />
                {img.caption && <p className="text-xs text-charcoal/50 dark:text-gray-500">{img.caption}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sections */}
      {sections && sections.length > 0 ? (
        <div className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-charcoal dark:text-gray-100">Quick Reference</h2>
          {sections.map((section) => {
            const sectionImages = imagesBySection[section.id] ?? [];
            const items = [...(section.local_info_items ?? [])].sort((a, b) => a.sort_order - b.sort_order);
            return (
              <Card key={section.id} className="flex flex-col gap-3 py-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-charcoal/50 dark:text-gray-500">
                  {section.title}
                </h3>
                {items.length > 0 && (
                  <dl className="flex flex-col gap-2">
                    {items.map((item) => (
                      <div key={item.id} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
                        <dt className="w-44 shrink-0 text-sm font-medium text-charcoal dark:text-gray-200">{item.label}</dt>
                        <dd className="text-sm text-charcoal/70 dark:text-gray-400">{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {sectionImages.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {sectionImages.map((img) => img && (
                      <div key={img.id} className="flex flex-col gap-1">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.storage_url} alt={img.caption ?? ''} className="w-full rounded-lg object-cover aspect-video" />
                        {img.caption && <p className="text-xs text-charcoal/50 dark:text-gray-500">{img.caption}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
          <p className="text-xs text-charcoal/30 dark:text-gray-600">
            Information is provisional and will be updated before the event.
          </p>
        </div>
      ) : (
        <Card>
          <p className="text-sm text-charcoal/60 dark:text-gray-400">Local info will be published before the event.</p>
        </Card>
      )}
    </div>
  );
}
