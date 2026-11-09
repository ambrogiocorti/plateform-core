import { environment } from '../config/environment';
import { hubHealth, hubLink } from '../api/venue-hub';

// Four independent facts, never merged into one "online" flag (ADR-0001):
// an active Wi-Fi does not prove that the cloud or the venue hub is reachable.
export type Connectivity = {
  network: 'UP' | 'DOWN';
  hub: 'NOT_PAIRED' | 'REACHABLE' | 'UNREACHABLE';
  cloud: 'REACHABLE' | 'UNREACHABLE';
  sync: 'NOT_APPLICABLE' | 'UP_TO_DATE' | 'PENDING' | 'UNKNOWN';
  checkedAt: string;
};

async function cloudReachable(): Promise<boolean> {
  const config = environment();
  try {
    const response = await fetch(`${config.supabaseUrl}/auth/v1/health`, {
      headers: { apikey: config.publishableKey },
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function probeConnectivity(): Promise<Connectivity> {
  const network = navigator.onLine ? 'UP' : 'DOWN';
  const paired = hubLink() !== null;
  const [cloud, hub] = await Promise.all([
    cloudReachable(),
    paired ? hubHealth().catch(() => null) : Promise.resolve(null),
  ]);
  return {
    network,
    hub: !paired ? 'NOT_PAIRED' : hub ? 'REACHABLE' : 'UNREACHABLE',
    cloud: cloud ? 'REACHABLE' : 'UNREACHABLE',
    sync: !paired
      ? 'NOT_APPLICABLE'
      : !hub
        ? 'UNKNOWN'
        : hub.sync_pending
          ? 'PENDING'
          : 'UP_TO_DATE',
    checkedAt: new Date().toISOString(),
  };
}

export function connectivitySummary(state: Connectivity): {
  tone: 'success' | 'warning' | 'danger';
  text: string;
  detail: string[];
} {
  const detail = [
    `Rete del dispositivo: ${state.network === 'UP' ? 'attiva' : 'assente'}`,
    `Hub di sede: ${
      state.hub === 'NOT_PAIRED'
        ? 'non associato'
        : state.hub === 'REACHABLE'
          ? 'raggiungibile'
          : 'non raggiungibile'
    }`,
    `Cloud: ${state.cloud === 'REACHABLE' ? 'raggiungibile' : 'non raggiungibile'}`,
    `Sincronizzazione: ${
      {
        NOT_APPLICABLE: 'non prevista',
        UP_TO_DATE: 'completata',
        PENDING: 'in attesa di invio al cloud',
        UNKNOWN: 'non verificabile',
      }[state.sync]
    }`,
  ];
  if (state.hub === 'UNREACHABLE')
    return { tone: 'danger', text: 'Hub di sede non raggiungibile', detail };
  if (state.hub === 'REACHABLE')
    return state.cloud === 'REACHABLE'
      ? {
          tone: state.sync === 'PENDING' ? 'warning' : 'success',
          text: state.sync === 'PENDING' ? 'Sincronizzazione in corso' : 'Servizio di sede attivo',
          detail,
        }
      : { tone: 'warning', text: 'Internet assente · servizio in sede attivo', detail };
  return state.cloud === 'REACHABLE'
    ? { tone: 'success', text: 'Collegato al cloud', detail }
    : { tone: 'danger', text: 'Cloud non raggiungibile', detail };
}
