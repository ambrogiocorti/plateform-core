import { client } from '../api/client';
import { publicMetricContext } from './public-site';

const sent = new Set<string>();
const firstDocumentRoute = publicMetricContext(location.pathname, location.search)?.key ?? null;

type MetricName = 'TTFB' | 'FCP' | 'LCP' | 'CLS' | 'INP';

function dispatch(body: Record<string, unknown>): void {
  void client()
    .functions.invoke('public-telemetry', { body })
    .catch(() => undefined);
}

export function recordPublicPageView(venueId?: string): void {
  const context = publicMetricContext(location.pathname, location.search);
  if (!context) return;
  const key = `view:${context.key}`;
  if (sent.has(key)) return;
  sent.add(key);
  dispatch({ event: 'PUBLIC_PAGE_VIEW', path: context.path, venue_id: venueId ?? null });
}

type MetricContext = NonNullable<ReturnType<typeof publicMetricContext>>;

function recordMetric(
  metric: MetricName,
  value: number,
  venueId: string | undefined,
  context: MetricContext | null,
): void {
  if (!context || !Number.isFinite(value) || value < 0) return;
  const normalized = metric === 'CLS' ? Math.min(100, value) : Math.min(60_000, value);
  const key = `metric:${metric}:${context.key}`;
  if (sent.has(key)) return;
  sent.add(key);
  dispatch({
    event: 'PUBLIC_PERFORMANCE',
    path: context.path,
    venue_id: venueId ?? null,
    metric,
    value: normalized,
  });
}

export function observePublicPerformance(venueId?: string): () => void {
  const observers: PerformanceObserver[] = [];
  const context = publicMetricContext(location.pathname, location.search);
  // Navigation and paint timings refer to the original HTML document only,
  // not every client-side route subsequently rendered in that document.
  const documentLoad = context?.key === firstDocumentRoute;
  const startedAt = performance.now();
  let disposed = false;
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
  if (documentLoad && navigation?.responseStart)
    recordMetric('TTFB', navigation.responseStart, venueId, context);
  observe('paint', (entry) => {
    if (documentLoad && entry.name === 'first-contentful-paint')
      recordMetric('FCP', entry.startTime, venueId, context);
  });
  observe('largest-contentful-paint', (entry) => {
    if (documentLoad || entry.startTime >= startedAt)
      recordMetric('LCP', entry.startTime, venueId, context);
  });
  let cls = 0;
  observe('layout-shift', (entry) => {
    const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
    if (!shift.hadRecentInput) cls += shift.value ?? 0;
  });
  observe('event', (entry) => {
    const event = entry as PerformanceEntry & { duration: number; interactionId?: number };
    if (event.interactionId && entry.startTime >= startedAt)
      recordMetric('INP', event.duration, venueId, context);
  });
  const flush = () => recordMetric('CLS', cls, venueId, context);
  const onPageHide = () => {
    if (!disposed) flush();
  };
  window.addEventListener('pagehide', onPageHide);
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('pagehide', onPageHide);
    flush();
    for (const observer of observers) observer.disconnect();
  };
}
