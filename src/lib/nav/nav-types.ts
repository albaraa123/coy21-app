/**
 * Plain, serializable navigation data types.
 *
 * These types intentionally exclude anything that cannot round-trip through
 * JSON.stringify/JSON.parse (no functions, no component references, no
 * class instances). The nav config modules built on top of these types are
 * consumed by server and client code alike, so they must stay pure data.
 *
 * `iconKey` is a lookup key into `icon-map.ts` (client-side only) — never a
 * component reference itself.
 */

export interface NavItem {
  labelKey: string;
  href: string;
  iconKey: string;
  children?: NavItem[];
  /** Which nav surface this item belongs to for participant-shell layouts using a bottom tab bar. Unused by admin nav configs. */
  placement?: 'primary' | 'more';
}

export interface NavGroup {
  labelKey: string;
  items: NavItem[];
}
