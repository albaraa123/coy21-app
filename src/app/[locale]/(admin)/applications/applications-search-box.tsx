'use client';

// Free-text search for the admin applications list — writes/reads the `q`
// URL param the Server Component page (page.tsx) already consumes in its
// profiles.full_name/profiles.email `.or()` filter. Debounced so typing
// doesn't fire a navigation (and therefore a full server re-fetch) on
// every keystroke.
import { useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/routing';
import { Input } from '@/components/ui/input';

const DEBOUNCE_MS = 400;

export function ApplicationsSearchBox({ placeholder }: { placeholder: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Initializer only -- intentionally not re-synced from searchParams on
  // every render (the only thing that ever changes `q` is this
  // component's own router.replace below, so re-deriving from
  // searchParams would just fight the user's in-progress typing).
  const [value, setValue] = useState(searchParams.get('q') ?? '');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleChange(next: string) {
    setValue(next);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (next.trim()) {
        params.set('q', next.trim());
      } else {
        params.delete('q');
      }
      // A new search supersedes whatever page the previous filter left us
      // on -- otherwise a narrower result set can land on an out-of-range
      // page and show "Page N of 0" until the user notices and clears it.
      params.delete('page');
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    }, DEBOUNCE_MS);
  }

  return (
    <Input
      type="search"
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="max-w-xs"
    />
  );
}
