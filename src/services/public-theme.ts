export type PublicTheme = 'light' | 'dark';

const preferenceKey = 'plateform-public-theme';
let pagePreference: PublicTheme | null = null;

export function preferredPublicTheme(fallback: PublicTheme = 'light'): PublicTheme {
  if (pagePreference) return pagePreference;
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Private browsing can prevent access to local storage.
  }
  return fallback;
}

export function savePublicTheme(theme: PublicTheme): void {
  pagePreference = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(preferenceKey, theme);
  } catch {
    // The choice still applies for this page when persistence is unavailable.
  }
}
