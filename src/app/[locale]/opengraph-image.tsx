// src/app/[locale]/opengraph-image.tsx
//
// Social share preview card (WhatsApp/Twitter/LinkedIn/Facebook link
// unfurls) — previously missing entirely, so sharing the site link
// produced no image/title/description card anywhere. Generated at
// request time via Next.js's built-in opengraph-image convention
// (ImageResponse/Satori) rather than a static design asset, so it can
// reuse the real icon mark and real brand colors/copy directly instead
// of needing a separately maintained image file.
import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  // Read the real brand icon from disk and inline it as a data URI —
  // Satori (ImageResponse's renderer) needs either a data URI or a
  // reachable absolute URL for <img>; a hardcoded production domain
  // would silently fail in local dev and preview deployments, so this
  // reads the same file public/brand/icon/icon-color.png already serves
  // directly instead.
  const iconPath = join(process.cwd(), 'public', 'brand', 'icon', 'icon-color.png');
  const iconData = await readFile(iconPath);
  const iconSrc = `data:image/png;base64,${iconData.toString('base64')}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f0f4f8',
          backgroundImage: 'linear-gradient(120deg, #f0f4f8 0%, #e3f2ee 45%, #f6ecd9 100%)',
        }}
      >
        <img
          // eslint-disable-next-line @next/next/no-img-element
          src={iconSrc}
          width={160}
          height={160}
          alt=""
        />
        <div
          style={{
            marginTop: 36,
            fontSize: 64,
            fontWeight: 700,
            color: '#0a1a2e',
          }}
        >
          COY21 Türkiye 2026
        </div>
        <div
          style={{
            marginTop: 16,
            fontSize: 30,
            color: '#0a1a2eb3',
          }}
        >
          Antalya, Türkiye · November 5–7, 2026
        </div>
      </div>
    ),
    { ...size }
  );
}
