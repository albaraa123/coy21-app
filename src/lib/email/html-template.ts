// src/lib/email/html-template.ts
//
// Shared HTML template builder for every branded transactional/notification
// email this codebase sends (see docs/superpowers/specs/
// 2026-10-13-branded-email-templates-design.md for the full design). Kept
// separate from resend.ts (which stays focused on WHAT each email says, not
// HOW the HTML is assembled -- resend.ts is already large).
//
// Table-based layout with inline styles throughout -- the only approach
// that renders consistently across email clients, notably Outlook's
// Word-based rendering engine, which does not support flexbox/grid/
// external CSS. Every interpolated value goes through escapeHtml (copied
// from resend.ts's existing helper -- see Step on resend.ts below for the
// single-source-of-truth decision) before being placed in the output.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type BadgeColor = 'green' | 'red' | 'blue' | 'gold';

const BADGE_COLORS: Record<BadgeColor, { text: string; bg: string }> = {
  green: { text: '#3d9920', bg: '#e8f5e0' },
  red: { text: '#c0392b', bg: '#fdecea' },
  blue: { text: '#019de6', bg: '#e6f4fb' },
  gold: { text: '#b8860b', bg: '#fdf3e3' },
};

export interface BrandedEmailParams {
  locale: 'ar' | 'en';
  badge?: { label: string; color: BadgeColor };
  heading: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  logoUrl: string;
}

// Renders just the inner content card (logo header + badge + heading +
// paragraphs + CTA) WITHOUT the outer <html>/<body>/page-background
// wrapper -- used directly by buildBrandedEmailHtml for the normal
// single-locale case, and called twice (once per locale) by
// sendLoginDetailsEmail's bilingual migration in resend.ts, which stacks
// two of these sections inside one page itself.
export function buildBrandedEmailBodySection(params: BrandedEmailParams): string {
  const dir = params.locale === 'ar' ? 'rtl' : 'ltr';
  const heading = escapeHtml(params.heading);
  const logoUrl = escapeHtml(params.logoUrl);

  const badgeHtml = params.badge
    ? (() => {
        const colors = BADGE_COLORS[params.badge!.color];
        const label = escapeHtml(params.badge!.label);
        return `<div style="display:inline-block;background:${colors.bg};color:${colors.text};font-size:12px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px;">${label}</div>`;
      })()
    : '';

  // A single '\n' inside one paragraph entry becomes <br> (not a new <p>,
  // not dropped) -- e.g. sendSessionRescheduleNotificationEmail's
  // "Previous time: X\nNew time: Y" block. escapeHtml runs on the raw text
  // FIRST, then \n is split into <br>-joined lines, so a literal "\n"
  // inside escaped/attacker-controlled text can never itself produce a
  // <br> tag -- only this function's own intentional split does.
  const paragraphsHtml = params.paragraphs
    .map((p) => {
      const escaped = escapeHtml(p);
      const withBreaks = escaped.split('\n').join('<br />');
      return `<p style="margin:0 0 16px;color:#555555;font-size:14px;line-height:1.6;">${withBreaks}</p>`;
    })
    .join('');

  const ctaHtml = params.cta
    ? `<div style="text-align:center;margin-top:8px;"><a href="${escapeHtml(params.cta.url)}" style="display:inline-block;background:#3d9920;color:#ffffff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none;">${escapeHtml(params.cta.label)}</a></div>`
    : '';

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);" dir="${dir}">
      <tr>
        <td style="background-color:#053269;padding:28px 24px;text-align:center;">
          <img src="${logoUrl}" alt="COY21" style="height:56px;width:auto;" />
        </td>
      </tr>
      <tr>
        <td style="padding:28px 24px;">
          ${badgeHtml}
          <h2 style="margin:0 0 12px;color:#0a1a2e;font-size:18px;">${heading}</h2>
          ${paragraphsHtml}
          ${ctaHtml}
        </td>
      </tr>
    </table>`;
}

// Full standalone HTML page for the normal (single-locale) case: one
// buildBrandedEmailBodySection wrapped in <html>/<body> plus the
// warm-white page background and footer. sendLoginDetailsEmail does NOT
// call this directly -- it calls buildBrandedEmailBodySection twice and
// assembles its own bilingual page (see resend.ts).
export function buildBrandedEmailHtml(params: BrandedEmailParams): string {
  const dir = params.locale === 'ar' ? 'rtl' : 'ltr';
  const section = buildBrandedEmailBodySection(params);

  return `<!doctype html>
<html lang="${params.locale}" dir="${dir}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>COY21 Türkiye 2026</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f0f4f8;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4f8;padding:24px 0;">
      <tr>
        <td align="center">
          ${section}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td style="padding:16px 24px;text-align:center;color:#8899aa;font-size:11px;">
                COY21 Türkiye 2026 · Antalya, 5–7 Nov 2026
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
