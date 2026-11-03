// src/app/[locale]/(participant)/(welcome)/welcome/slide-illustrations.tsx
//
// One small, real-UI-shaped illustration per walkthrough slide -- built as
// plain HTML/CSS mockups of the actual platform surface each slide talks
// about (the sidebar, a session card, the QR card, etc.), not a literal
// screenshot. Kept in its own file since walkthrough-client.tsx is already
// doing layout/state and these are purely decorative markup, one per
// SLIDE_KEYS entry, indexed the same way.
export function Slide1Illustration() {
  return (
    <div className="flex items-center justify-center gap-3 rounded-xl border border-charcoal/10 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-turquoise/10 text-2xl">👋</div>
      <div className="flex flex-col gap-1.5">
        <div className="h-2.5 w-28 rounded-full bg-charcoal/15 dark:bg-gray-700" />
        <div className="h-2.5 w-20 rounded-full bg-charcoal/10 dark:bg-gray-800" />
      </div>
    </div>
  );
}

export function Slide2Illustration() {
  const items: { label: string; active?: boolean; faded?: boolean }[] = [
    { label: 'Dashboard' },
    { label: 'My Program', active: true },
    { label: 'My QR Code' },
    { label: 'Conference Program', faded: true },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-charcoal/10 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
      {items.map((item) => (
        <div
          key={item.label}
          className={`flex items-center gap-2.5 border-b border-charcoal/5 px-4 py-2.5 text-xs font-medium last:border-0 dark:border-gray-800 ${
            item.active ? 'bg-turquoise/10 text-turquoise' : item.faded ? 'text-charcoal/30 dark:text-gray-600' : 'text-charcoal/70 dark:text-gray-300'
          }`}
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.active ? 'bg-turquoise' : 'bg-charcoal/20 dark:bg-gray-700'}`} />
          {item.label}
        </div>
      ))}
    </div>
  );
}

export function Slide3Illustration() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-charcoal/10 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between rounded-lg bg-charcoal/[0.04] px-3 py-2 dark:bg-gray-800">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[#053269]" />
          <span className="text-xs font-medium text-charcoal/60 dark:text-gray-400">Opening Plenary</span>
        </div>
        <span className="rounded-full bg-charcoal/10 px-2 py-0.5 text-[10px] font-semibold text-charcoal/50 dark:bg-gray-700 dark:text-gray-400">Automatic</span>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-[#e07a1f]/30 bg-[#e07a1f]/[0.06] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[#e07a1f]" />
          <span className="text-xs font-medium text-charcoal dark:text-gray-200">Youth, AI and Climate Action</span>
        </div>
        <span className="rounded-full bg-green px-2.5 py-0.5 text-[10px] font-semibold text-white">Book</span>
      </div>
    </div>
  );
}

export function Slide4Illustration() {
  return (
    <div className="flex items-center justify-center gap-4 rounded-xl border border-charcoal/10 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="grid h-20 w-20 shrink-0 grid-cols-5 grid-rows-5 gap-[2px] rounded-md bg-charcoal p-2 dark:bg-gray-200">
        {Array.from({ length: 25 }).map((_, i) => (
          <span
            key={i}
            className="rounded-[1px]"
            style={{ backgroundColor: [0, 1, 4, 5, 9, 10, 14, 15, 19, 20, 24].includes(i) ? 'transparent' : i % 3 === 0 ? '#fff' : 'transparent' }}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="h-2.5 w-24 rounded-full bg-charcoal/15 dark:bg-gray-700" />
        <span className="text-[10px] font-medium text-charcoal/40 dark:text-gray-500">Scan at entry</span>
      </div>
    </div>
  );
}

export function Slide5Illustration() {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-2 rounded-xl border border-charcoal/10 bg-white p-3.5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <span className="text-base">✈️</span>
        <div className="h-2 w-full rounded-full bg-charcoal/10 dark:bg-gray-800" />
        <div className="h-2 w-2/3 rounded-full bg-charcoal/10 dark:bg-gray-800" />
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-charcoal/10 bg-white p-3.5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <span className="text-base">🪪</span>
        <div className="h-2 w-full rounded-full bg-charcoal/10 dark:bg-gray-800" />
        <div className="h-2 w-2/3 rounded-full bg-charcoal/10 dark:bg-gray-800" />
      </div>
    </div>
  );
}

export function Slide6Illustration() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-charcoal/10 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="relative flex h-16 items-center justify-center rounded-lg bg-charcoal/[0.04] dark:bg-gray-800">
        <span className="absolute left-[30%] top-1/3 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#053269] shadow" />
        <span className="absolute left-[55%] top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-green shadow" />
        <span className="absolute left-[70%] top-2/3 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#019de6] shadow" />
        <span className="text-[10px] font-medium text-charcoal/30 dark:text-gray-600">Venue map</span>
      </div>
      <div className="flex items-center gap-2 rounded-lg bg-[#c0392b]/[0.08] px-3 py-1.5">
        <span className="text-xs">🚑</span>
        <span className="text-[10px] font-semibold text-[#c0392b]">112</span>
      </div>
    </div>
  );
}

export function Slide7Illustration() {
  const items = ['QR code saved', 'Badge on you', "Today's bookings confirmed"];
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-charcoal/10 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      {items.map((item) => (
        <div key={item} className="flex items-center gap-2.5">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-green text-[9px] font-bold text-white">✓</span>
          <span className="text-xs text-charcoal/70 dark:text-gray-300">{item}</span>
        </div>
      ))}
    </div>
  );
}

export function Slide8Illustration() {
  return (
    <div className="flex items-center justify-center rounded-xl border border-charcoal/10 bg-gradient-to-br from-turquoise/5 to-green/5 p-8 shadow-sm dark:border-gray-800">
      <span className="text-4xl">🎉</span>
    </div>
  );
}

export const SLIDE_ILLUSTRATIONS = [
  Slide1Illustration,
  Slide2Illustration,
  Slide3Illustration,
  Slide4Illustration,
  Slide5Illustration,
  Slide6Illustration,
  Slide7Illustration,
  Slide8Illustration,
];
