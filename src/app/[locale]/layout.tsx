import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { thmanyahSerif } from "@/lib/fonts";
import "../globals.css";

export const metadata: Metadata = {
  title: "COY21 Türkiye 2026",
  description: "COY21 Türkiye 2026 conference registration",
  appleWebApp: {
    // 'default' (not 'black-translucent') so the iOS status bar keeps a
    // solid background instead of overlaying page content — the scanner
    // UI has real content near the top edge that a translucent bar
    // would sit on top of.
    capable: true,
    statusBarStyle: "default",
    title: "COY21 Scanner",
  },
};

export const viewport: Viewport = {
  themeColor: "#007a78",
  width: "device-width",
  initialScale: 1,
  // Lets the layout account for the iOS home indicator / Android
  // gesture bar via env(safe-area-inset-*) instead of content sitting
  // underneath it in standalone mode.
  viewportFit: "cover",
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  return (
    <html
      lang="en"
      dir="ltr"
      className={`${thmanyahSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
