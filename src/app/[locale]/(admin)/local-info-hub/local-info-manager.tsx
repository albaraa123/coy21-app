'use client';

import { useState, useTransition, useRef } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  createSection, updateSection, deleteSection, toggleSectionActive,
  createItem, updateItem, deleteItem,
  uploadImage, deleteImage,
} from './actions';

type Item = { id: string; label: string; value: string; sort_order: number };
type Image = { id: string; section_id: string | null; caption: string | null; storage_url: string; sort_order: number };
type Section = {
  id: string;
  title: string;
  sort_order: number;
  is_active: boolean;
  local_info_items: Item[];
};

export function LocalInfoManager({
  sections: initial,
  images: initialImages,
}: {
  sections: Section[];
  images: Image[];
}) {
  const [sections, setSections] = useState(initial);
  const [images, setImages] = useState(initialImages);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Per-section expanded state
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function handleError(result: { error: string | null }) {
    if (result.error) setError(result.error);
    else setError(null);
  }

  // ── Section actions ─────────────────────────────────────────────────────

  function handleCreateSection(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    e.currentTarget.reset();
    startTransition(async () => {
      const res = await createSection(fd);
      handleError(res);
      if (!res.error) {
        // optimistic: server will revalidate, but let's just reload
        window.location.reload();
      }
    });
  }

  function handleDeleteSection(id: string) {
    startTransition(async () => {
      const res = await deleteSection(id);
      handleError(res);
      if (!res.error) setSections((prev) => prev.filter((s) => s.id !== id));
    });
  }

  function handleToggleSection(id: string, current: boolean) {
    startTransition(async () => {
      const res = await toggleSectionActive(id, !current);
      handleError(res);
      if (!res.error) {
        setSections((prev) => prev.map((s) => s.id === id ? { ...s, is_active: !current } : s));
      }
    });
  }

  // ── Item actions ─────────────────────────────────────────────────────────

  function handleCreateItem(e: React.FormEvent<HTMLFormElement>, sectionId: string) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set('section_id', sectionId);
    e.currentTarget.reset();
    startTransition(async () => {
      const res = await createItem(fd);
      handleError(res);
      if (!res.error) window.location.reload();
    });
  }

  function handleDeleteItem(id: string, sectionId: string) {
    startTransition(async () => {
      const res = await deleteItem(id);
      handleError(res);
      if (!res.error) {
        setSections((prev) => prev.map((s) =>
          s.id === sectionId
            ? { ...s, local_info_items: s.local_info_items.filter((i) => i.id !== id) }
            : s
        ));
      }
    });
  }

  // ── Image actions ────────────────────────────────────────────────────────

  const fileRef = useRef<HTMLInputElement>(null);

  function handleUploadImage(e: React.FormEvent<HTMLFormElement>, sectionId: string | null) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (sectionId) fd.set('section_id', sectionId);
    startTransition(async () => {
      const res = await uploadImage(fd);
      handleError(res);
      if (!res.error) window.location.reload();
    });
  }

  function handleDeleteImage(id: string) {
    startTransition(async () => {
      const res = await deleteImage(id);
      handleError(res);
      if (!res.error) setImages((prev) => prev.filter((img) => img.id !== id));
    });
  }

  const generalImages = images.filter((img) => !img.section_id);

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Add section */}
      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">Add Section</h2>
        <form onSubmit={handleCreateSection} className="flex gap-2">
          <input
            name="title"
            required
            placeholder="Section title (e.g. Emergency Numbers)"
            className="flex-1 rounded-md border border-charcoal/20 bg-white px-3 py-1.5 text-sm text-charcoal placeholder:text-charcoal/40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <Button type="submit" disabled={isPending}>Add</Button>
        </form>
      </Card>

      {/* General images (not tied to a section) */}
      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">General Images</h2>
        <p className="text-xs text-charcoal/50 dark:text-gray-500">Shown at the top of the Local Info page, not tied to any section.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {generalImages.map((img) => (
            <div key={img.id} className="relative flex flex-col gap-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.storage_url} alt={img.caption ?? ''} className="w-full rounded-lg object-cover aspect-video" />
              {img.caption && <p className="text-xs text-charcoal/50">{img.caption}</p>}
              <button
                onClick={() => handleDeleteImage(img.id)}
                disabled={isPending}
                className="absolute top-1 right-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-600"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <form onSubmit={(e) => handleUploadImage(e, null)} className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-charcoal/60 dark:text-gray-400">Image (max 5 MB)</label>
            <input ref={fileRef} name="file" type="file" accept="image/*" required
              className="text-sm file:mr-2 file:rounded file:border-0 file:bg-turquoise file:px-3 file:py-1 file:text-white file:text-xs" />
          </div>
          <input name="caption" placeholder="Caption (optional)"
            className="flex-1 min-w-36 rounded-md border border-charcoal/20 bg-white px-3 py-1.5 text-sm text-charcoal placeholder:text-charcoal/40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500" />
          <Button type="submit" disabled={isPending}>Upload</Button>
        </form>
      </Card>

      {/* Sections list */}
      {sections.map((section) => {
        const isOpen = !!expanded[section.id];
        const sectionImages = images.filter((img) => img.section_id === section.id);
        const items = [...section.local_info_items].sort((a, b) => a.sort_order - b.sort_order);

        return (
          <Card key={section.id} className="flex flex-col gap-4">
            {/* Section header */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => toggle(section.id)}
                className="flex-1 text-start text-sm font-semibold text-charcoal dark:text-gray-100"
              >
                {isOpen ? '▾' : '▸'} {section.title}
                {!section.is_active && (
                  <span className="ml-2 rounded bg-charcoal/10 px-1.5 py-0.5 text-[10px] text-charcoal/50 dark:bg-white/10 dark:text-gray-500">
                    hidden
                  </span>
                )}
              </button>
              <button
                onClick={() => handleToggleSection(section.id, section.is_active)}
                disabled={isPending}
                className="text-xs text-charcoal/50 hover:text-charcoal dark:text-gray-500 dark:hover:text-gray-300"
              >
                {section.is_active ? 'Hide' : 'Show'}
              </button>
              <button
                onClick={() => {
                  if (confirm(`Delete section "${section.title}" and all its items?`))
                    handleDeleteSection(section.id);
                }}
                disabled={isPending}
                className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400"
              >
                Delete
              </button>
            </div>

            {isOpen && (
              <>
                {/* Items */}
                {items.length > 0 && (
                  <div className="flex flex-col gap-1 border-t border-charcoal/10 pt-3 dark:border-gray-700">
                    {items.map((item) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        sectionId={section.id}
                        isPending={isPending}
                        onDelete={handleDeleteItem}
                        onUpdate={(id, fd) => {
                          startTransition(async () => {
                            const res = await updateItem(id, fd);
                            handleError(res);
                            if (!res.error) window.location.reload();
                          });
                        }}
                      />
                    ))}
                  </div>
                )}

                {/* Add item */}
                <form
                  onSubmit={(e) => handleCreateItem(e, section.id)}
                  className="flex flex-wrap gap-2 border-t border-charcoal/10 pt-3 dark:border-gray-700"
                >
                  <input name="label" required placeholder="Label (e.g. Police)"
                    className="w-36 rounded-md border border-charcoal/20 bg-white px-3 py-1.5 text-sm text-charcoal placeholder:text-charcoal/40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500" />
                  <input name="value" required placeholder="Value (e.g. 155)"
                    className="flex-1 min-w-48 rounded-md border border-charcoal/20 bg-white px-3 py-1.5 text-sm text-charcoal placeholder:text-charcoal/40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500" />
                  <Button type="submit" disabled={isPending} variant="secondary">+ Add Row</Button>
                </form>

                {/* Section images */}
                <div className="flex flex-col gap-3 border-t border-charcoal/10 pt-3 dark:border-gray-700">
                  <p className="text-xs font-medium text-charcoal/50 dark:text-gray-500 uppercase tracking-wide">Images</p>
                  {sectionImages.length > 0 && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {sectionImages.map((img) => (
                        <div key={img.id} className="relative flex flex-col gap-1">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={img.storage_url} alt={img.caption ?? ''} className="w-full rounded-lg object-cover aspect-video" />
                          {img.caption && <p className="text-xs text-charcoal/50">{img.caption}</p>}
                          <button
                            onClick={() => handleDeleteImage(img.id)}
                            disabled={isPending}
                            className="absolute top-1 right-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-600"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <form onSubmit={(e) => handleUploadImage(e, section.id)} className="flex flex-wrap gap-2 items-end">
                    <input name="file" type="file" accept="image/*" required
                      className="text-sm file:mr-2 file:rounded file:border-0 file:bg-turquoise file:px-3 file:py-1 file:text-white file:text-xs" />
                    <input name="caption" placeholder="Caption (optional)"
                      className="flex-1 min-w-36 rounded-md border border-charcoal/20 bg-white px-3 py-1.5 text-sm text-charcoal placeholder:text-charcoal/40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500" />
                    <Button type="submit" disabled={isPending} variant="secondary">Upload</Button>
                  </form>
                </div>
              </>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ── Inline item row with edit-in-place ───────────────────────────────────────

function ItemRow({
  item,
  sectionId,
  isPending,
  onDelete,
  onUpdate,
}: {
  item: Item;
  sectionId: string;
  isPending: boolean;
  onDelete: (id: string, sectionId: string) => void;
  onUpdate: (id: string, fd: FormData) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(item.label);
  const [value, setValue] = useState(item.value);

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-36 rounded-md border border-charcoal/20 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 min-w-48 rounded-md border border-charcoal/20 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        <button
          onClick={() => {
            const fd = new FormData();
            fd.set('label', label);
            fd.set('value', value);
            onUpdate(item.id, fd);
            setEditing(false);
          }}
          disabled={isPending}
          className="text-xs text-turquoise hover:underline"
        >
          Save
        </button>
        <button onClick={() => setEditing(false)} className="text-xs text-charcoal/40 hover:text-charcoal">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-36 shrink-0 text-sm font-medium text-charcoal dark:text-gray-200 truncate">{item.label}</span>
      <span className="flex-1 text-sm text-charcoal/70 dark:text-gray-400 truncate">{item.value}</span>
      <button onClick={() => setEditing(true)} className="text-xs text-charcoal/40 hover:text-turquoise">Edit</button>
      <button
        onClick={() => onDelete(item.id, sectionId)}
        disabled={isPending}
        className="text-xs text-red-400 hover:text-red-600"
      >
        ×
      </button>
    </div>
  );
}
