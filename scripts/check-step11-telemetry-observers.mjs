import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Load the *real* TypeScript modules with a network-free Supabase transport.
// This is a browser API contract test and needs no npm dependencies.
const dir = await mkdtemp(join(tmpdir(), 'plateform-telemetry-e2e-'));
try {
  const telemetry = (await readFile('src/services/public-telemetry.ts', 'utf8'))
    .replace("from '../api/client'", "from './test-client.ts'")
    .replace("from './public-site'", "from './public-site.ts'");
  await writeFile(join(dir, 'public-telemetry.ts'), telemetry);
  await writeFile(join(dir, 'public-site.ts'), await readFile('src/services/public-site.ts'));
  await writeFile(join(dir, 'test-client.ts'), `
export const client = () => ({functions: {invoke: async (_name, {body}) => {
  globalThis.__plateformTestEvents.push(body);
  return { data: {accepted:true}, error:null };
}}});
`);
  globalThis.__plateformTestEvents = [];
  globalThis.location = { pathname: '/menu/carta-vini', search: '?sede=navigli&token=should-never-be-stored' };
  const eventListeners = new Map();
  globalThis.window = {
    PerformanceObserver: true,
    addEventListener: (name, listener) => {
      if (!eventListeners.has(name)) eventListeners.set(name, new Set());
      eventListeners.get(name).add(listener);
    },
    removeEventListener: (name, listener) => eventListeners.get(name)?.delete(listener),
  };
  const observers = [];
  globalThis.PerformanceObserver = class {
    constructor(callback) { this.callback = callback; this.type = ''; this.disconnected = false; observers.push(this); }
    observe({type}) { this.type = type; }
    disconnect() { this.disconnected = true; }
    emit(...entries) { this.callback({getEntries: () => entries}); }
  };
  globalThis.performance = { now: () => 500,
    getEntriesByType: (name) => name === 'navigation' ? [{responseStart:60}] : [],
  };
  const { recordPublicPageView, observePublicPerformance } = await import(
    pathToFileURL(join(dir, 'public-telemetry.ts')).href);
  recordPublicPageView('venue-1');
  const stopOld = observePublicPerformance('venue-1');
  observers.find((x) => x.type === 'layout-shift')?.emit({startTime:510,value:0.4,hadRecentInput:false});
  const oldCount = observers.length;
  assert.equal(oldCount, 4);
  assert.equal(globalThis.__plateformTestEvents.filter((x) => x.metric === 'TTFB').length, 1);
  assert.ok(globalThis.__plateformTestEvents.every((event) => !JSON.stringify(event).includes('should-never-be-stored')),
    'telemetry payloads must not contain arbitrary search tokens');

  // Simulate SPA navigation before the previous route's CLS observer is closed.
  globalThis.location.pathname = '/contatti';
  globalThis.location.search = '';
  stopOld();
  assert.equal(eventListeners.get('pagehide')?.size, 0, 'cleanup removes old pagehide listener');
  assert.ok(observers.slice(0,oldCount).every((x) => x.disconnected));
  const oldCls = globalThis.__plateformTestEvents.find((x) => x.metric === 'CLS');
  assert.equal(oldCls?.path, '/menu/:slug', 'CLS must belong to the previous menu');
  assert.equal(oldCls?.value, 0.4);
  for (const listener of eventListeners.get('pagehide') || []) listener();
  assert.equal(globalThis.__plateformTestEvents.filter((x) => x.metric === 'CLS').length, 1,
    'cleared pagehide listeners must not emit a duplicate');

  const stopNew = observePublicPerformance('venue-2');
  assert.equal(globalThis.__plateformTestEvents.filter((x) => x.metric === 'TTFB').length, 1,
    'hard-navigation TTFB must not be duplicated for a SPA route');
  observers.find((x, i) => i >= oldCount && x.type === 'paint')?.emit({name:'first-contentful-paint', startTime:25});
  assert.equal(globalThis.__plateformTestEvents.filter((x) => x.metric === 'FCP').length, 0,
    'buffered document paint must not be assigned to a SPA route');
  observers.find((x, i) => i >= oldCount && x.type === 'largest-contentful-paint')?.emit({startTime:620});
  assert.equal(globalThis.__plateformTestEvents.find((x) => x.metric === 'LCP')?.path, '/contatti');
  stopNew();
  assert.equal(eventListeners.get('pagehide')?.size, 0);

  globalThis.location.pathname = '/tavolo/private-session-token';
  recordPublicPageView();
  const before = globalThis.__plateformTestEvents.length;
  const stopQr = observePublicPerformance();
  stopQr();
  assert.equal(globalThis.__plateformTestEvents.length, before,
    'customer QR/session paths must not generate public analytics');
  console.log('STEP11_TELEMETRY_LIFECYCLE=PASS (13 contract assertions)');
} finally {
  await rm(dir, { recursive:true, force:true });
  delete globalThis.__plateformTestEvents;
  delete globalThis.PerformanceObserver;
  delete globalThis.location;
  delete globalThis.performance;
  delete globalThis.window;
}
