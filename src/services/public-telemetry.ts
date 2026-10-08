import { client } from '../api/client';
import { normalizePublicPath } from './public-site';

const sent = new Set<string>();

type MetricName = 'TTFB' | 'FCP' | 'LCP' | 'CLS' | 'INP';

function publicPath(): Exclude<
  ReturnType<typeof normalizePublicPath>,
  '/tavolo/:id' | null
> | null {
  const path = normalizePublicPath(location.pathname);
  return path && path !== '/tavolo/:id' ? path : null;
}

function dispatch(body: Record<string, unknown>): void {
  void client()
    .functions.invoke('public-telemetry', { body })
    .catch(() => undefined);
}

export function recordPublicPageView(venueId?: string): void {
  const path = publicPath();
  if (!path) return;
  const key = `view:${location.pathname}${location.search}`;
  if (sent.has(key)) return;
  sent.add(key);
  dispatch({ event: 'PUBLIC_PAGE_VIEW', path, venue_id: venueId ?? null });
}

function recordMetric(metric: MetricName, value: number, venueId?: string): void {
  const path = publicPath();
  if (!path || !Number.isFinite(value) || value < 0) return;
  const normalized = metric === 'CLS' ? Math.min(100, value) : Math.min(60_000, value);
  const key = `metric:${metric}:${location.pathname}${location.search}`;
  if (sent.has(key)) return;
  sent.add(key);
  dispatch({
    event: 'PUBLIC_PERFORMANCE',
    path,
    venue_id: venueId ?? null,
    metric,
    value: normalized,
  });
}

export function observePublicPerformance(venueId?: string): () => void {
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, callback: (entry: PerformanceEntry) => void) => {
    if (!('PerformanceObserver' in window)) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) callback(entry);
      });
      observer.observe({ type, buffered: true });
      observers.push(observer);
    } catch {
      // Unsupported metric: observability is best effort and must never break navigation.
    }
  };
  const navigation = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  if (navigation?.responseStart) recordMetric('TTFB', navigation.responseStart, venueId);
  observe('paint', (entry) => {
    if (entry.name === 'first-contentful-paint') recordMetric('FCP', entry.startTime, venueId);
  });
  observe('largest-contentful-paint', (entry) => recordMetric('LCP', entry.startTime, venueId));
  let cls = 0;
  observe('layout-shift', (entry) => {
    const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
    if (!shift.hadRecentInput) cls += shift.value ?? 0;
  });
  observe('event', (entry) => {
    const event = entry as PerformanceEntry & { duration: number; interactionId?: number };
    if (event.interactionId) recordMetric('INP', event.duration, venueId);
  });
  const flush = () => recordMetric('CLS', cls, venueId);
  addEventListener('pagehide', flush, { once: true });
  return () => {
    flush();
    for (const observer of observers) observer.disconnect();
  };
}
