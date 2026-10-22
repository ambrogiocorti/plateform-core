/** The public site can be served under a sub-folder (for example a GitHub Pages project
 * site at /plateform/). Routing works on app paths ("/menu"); only the browser URL and
 * the rendered links carry the folder. With the default base "/" both helpers are no-ops. */
export function publicAppPath(pathname: string, base = import.meta.env.BASE_URL): string {
  if (base === '/') return pathname;
  const folder = base.replace(/\/$/, '');
  if (pathname === folder) return '/';
  return pathname.startsWith(base) ? pathname.slice(folder.length) : pathname;
}

export function withPublicBase(path: string, base = import.meta.env.BASE_URL): string {
  if (base === '/' || !path.startsWith('/') || path.startsWith('//')) return path;
  return base.replace(/\/$/, '') + path;
}
