import assert from 'node:assert/strict';
import vm from 'node:vm';
import { plateformPwa } from '../vite.pwa.ts';

function chunk(fileName, code) {
  return {
    type: 'chunk',
    fileName,
    name: fileName,
    code,
    map: null,
    modules: {},
    exports: [],
    imports: [],
    dynamicImports: [],
    implicitlyLoadedBefore: [],
    importedBindings: {},
    referencedFiles: [],
    preliminaryFileName: fileName,
    isDynamicEntry: false,
    isEntry: true,
    isImplicitEntry: false,
    facadeModuleId: null,
    moduleIds: [],
  };
}
function asset(fileName, source) {
  return { type: 'asset', fileName, names: [], originalFileNames: [], source };
}
function generate(area, base, staffBase, overrides = {}) {
  const emitted = [];
  const plugin = plateformPwa(area, base, staffBase);
  const bundle = {
    'index.html': asset('index.html', overrides.html ?? '<html>v1</html>'),
    'assets/main.js': chunk('assets/main.js', overrides.js ?? 'console.log("v1")'),
    'assets/main.css': asset('assets/main.css', overrides.css ?? 'body{margin:0}'),
  };
  if (typeof plugin.generateBundle !== 'function') throw new Error('PWA_GENERATE_HOOK_MISSING');
  plugin.generateBundle.call(
    {
      emitFile(value) {
        emitted.push(value);
        return String(emitted.length);
      },
    },
    {},
    bundle,
    false,
  );
  const sw = emitted.find((entry) => entry.fileName === 'sw.js');
  const manifest = emitted.find((entry) => entry.fileName === 'manifest.webmanifest');
  assert.ok(sw && typeof sw.source === 'string', 'service worker emitted');
  assert.ok(manifest && typeof manifest.source === 'string', 'manifest emitted');
  return { sw: sw.source, manifest: JSON.parse(manifest.source) };
}
function cacheName(source) {
  const match = /const CACHE=("[^"]+")/.exec(source);
  assert.ok(match, 'cache name embedded');
  return JSON.parse(match[1]);
}

class FakeCache {
  constructor() {
    this.entries = new Map();
  }
  key(input) {
    const value = typeof input === 'string' ? input : input.url;
    return new URL(value, 'https://plateform.test').href;
  }
  async addAll(urls) {
    for (const url of urls)
      this.entries.set(
        this.key(url),
        new Response(`cached:${new URL(url, 'https://plateform.test').pathname}`, { status: 200 }),
      );
  }
  async match(input) {
    return this.entries.get(this.key(input));
  }
}
class FakeCaches {
  constructor() {
    this.data = new Map();
  }
  async open(name) {
    if (!this.data.has(name)) this.data.set(name, new FakeCache());
    return this.data.get(name);
  }
  async keys() {
    return [...this.data.keys()];
  }
  async delete(name) {
    return this.data.delete(name);
  }
  async match(input) {
    for (const cache of this.data.values()) {
      const hit = await cache.match(input);
      if (hit) return hit;
    }
    return undefined;
  }
}
function workerRuntime(source, fetchImpl) {
  const listeners = new Map();
  const caches = new FakeCaches();
  let claimed = 0;
  let skipped = 0;
  const self = {
    location: { origin: 'https://plateform.test' },
    clients: {
      async claim() {
        claimed += 1;
      },
    },
    skipWaiting() {
      skipped += 1;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
  };
  vm.runInNewContext(source, { self, caches, fetch: fetchImpl, URL, Promise, Response, console });
  return { listeners, caches, claimed: () => claimed, skipped: () => skipped };
}
async function dispatchWait(listener, event = {}) {
  let promise;
  listener({
    ...event,
    waitUntil(value) {
      promise = Promise.resolve(value);
    },
  });
  await promise;
}
async function dispatchFetch(listener, request) {
  let responsePromise;
  listener({
    request,
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    },
  });
  return responsePromise ? await responsePromise : undefined;
}

const publicV1 = generate('public', '/', '/staff/');
const publicJsV2 = generate('public', '/', '/staff/', { js: 'console.log("v2")' });
const publicHtmlV2 = generate('public', '/', '/staff/', { html: '<html>v2</html>' });
assert.notEqual(
  cacheName(publicV1.sw),
  cacheName(publicJsV2.sw),
  'JS content changes cache version',
);
assert.notEqual(
  cacheName(publicV1.sw),
  cacheName(publicHtmlV2.sw),
  'HTML content changes cache version',
);
assert.equal(publicV1.manifest.scope, '/');
assert.equal(publicV1.manifest.start_url, '/');

let networkCalls = 0;
const runtime = workerRuntime(publicV1.sw, async (request) => {
  networkCalls += 1;
  if (request.mode === 'navigate') throw new Error('offline');
  return new Response('network', { status: 200 });
});
const install = runtime.listeners.get('install');
const activate = runtime.listeners.get('activate');
const message = runtime.listeners.get('message');
const fetchListener = runtime.listeners.get('fetch');
assert.ok(
  install && activate && message && fetchListener,
  'all service-worker handlers registered',
);
await dispatchWait(install);
const current = cacheName(publicV1.sw);
assert.ok((await runtime.caches.keys()).includes(current), 'install creates current cache');
await runtime.caches.open('plateform-public-obsolete');
await runtime.caches.open('unrelated-cache');
await dispatchWait(activate);
assert.equal(runtime.claimed(), 1, 'activate claims clients');
assert.ok(
  !(await runtime.caches.keys()).includes('plateform-public-obsolete'),
  'old same-area cache removed',
);
assert.ok((await runtime.caches.keys()).includes('unrelated-cache'), 'unrelated cache preserved');

const offlineNavigation = await dispatchFetch(fetchListener, {
  url: 'https://plateform.test/menu',
  method: 'GET',
  mode: 'navigate',
});
assert.equal(
  await offlineNavigation.text(),
  'cached:/index.html',
  'offline navigation falls back to cached shell',
);

networkCalls = 0;
const cachedAsset = await dispatchFetch(fetchListener, {
  url: 'https://plateform.test/assets/main.js',
  method: 'GET',
  mode: 'cors',
});
assert.equal(await cachedAsset.text(), 'cached:/assets/main.js', 'precache asset is cache-first');
assert.equal(networkCalls, 0, 'cached asset does not hit network');

const staffLeak = await dispatchFetch(fetchListener, {
  url: 'https://plateform.test/staff/index.html',
  method: 'GET',
  mode: 'navigate',
});
assert.equal(staffLeak, undefined, 'public worker never handles staff routes');
message({ data: 'ACTIVATE_UPDATE' });
assert.equal(runtime.skipped(), 1, 'controlled update message activates waiting worker');

const staff = generate('staff', '/staff/', '/staff/');
assert.equal(staff.manifest.scope, '/staff/');
assert.equal(staff.manifest.start_url, '/staff/');
const staffRuntime = workerRuntime(staff.sw, async () => new Response('network'));
await dispatchWait(staffRuntime.listeners.get('install'));
const outsideStaff = await dispatchFetch(staffRuntime.listeners.get('fetch'), {
  url: 'https://plateform.test/menu',
  method: 'GET',
  mode: 'navigate',
});
assert.equal(outsideStaff, undefined, 'staff worker stays inside its scope');

console.log('STEP8_PWA_RUNTIME_GATE=PASSED');
