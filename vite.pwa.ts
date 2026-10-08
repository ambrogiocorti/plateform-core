import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
export function plateformPwa(
  area: 'public' | 'staff',
  base: string,
  staffBase = '/staff/',
): Plugin {
  return {
    name: 'plateform-pwa',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((file) => /\.(js|css|woff2|svg|png)$/.test(file));
      const versionHash = createHash('sha256');
      for (const file of Object.keys(bundle).sort()) {
        const output = bundle[file];
        if (!output) continue;
        versionHash.update(file);
        versionHash.update('\0');
        if (output.type === 'chunk') versionHash.update(output.code);
        else if (typeof output.source === 'string') versionHash.update(output.source);
        else versionHash.update(Buffer.from(output.source));
        versionHash.update('\0');
      }
      const version = versionHash.digest('hex').slice(0, 16);
      const assets = [`${base}index.html`, ...files.map((file) => base + file), `${base}icon.svg`];
      const source = `const CACHE=${JSON.stringify(`plateform-${area}-${version}`)},PREFIX=${JSON.stringify(`plateform-${area}-`)},BASE=${JSON.stringify(base)},STAFF=${JSON.stringify(staffBase)},ASSETS=${JSON.stringify(assets)};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith(PREFIX)&&name!==CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith(BASE)${area === 'public' ? '||url.pathname.startsWith(STAFF)' : ''})return;
if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match(BASE+'index.html')));return;}
if(ASSETS.includes(url.pathname))event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify({
          id: base,
          name: area === 'staff' ? 'Plateform · Staff' : 'Plateform',
          short_name: 'Plateform',
          start_url: base,
          scope: base,
          display: 'standalone',
          background_color: '#111315',
          theme_color: '#111315',
          lang: 'it',
          icons: [{ src: base + 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        }),
      });
    },
  };
}
