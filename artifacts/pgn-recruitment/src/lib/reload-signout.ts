export type NavigationType = 'navigate' | 'reload' | 'back_forward' | 'prerender';

export type StartupNavigationSnapshot = {
  navigationType: NavigationType;
  pathname: string;
};

type StartupState = {
  snapshot: StartupNavigationSnapshot;
  signOutAttempted: boolean;
};

const startupStateKey = '__pgnRecruitmentStartupNavigation';

function readNavigationType(): NavigationType {
  if (typeof performance === 'undefined') return 'navigate';

  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (entry?.type === 'reload' || entry?.type === 'back_forward' || entry?.type === 'prerender') {
    return entry.type;
  }

  // Keep a fallback for browsers that do not expose PerformanceNavigationTiming.
  const legacyType = (performance as Performance & { navigation?: { type?: number } }).navigation?.type;
  return legacyType === 1 ? 'reload' : legacyType === 2 ? 'back_forward' : 'navigate';
}

function readStartupState(): StartupState {
  if (typeof window === 'undefined') {
    return { snapshot: { navigationType: 'navigate', pathname: '/' }, signOutAttempted: false };
  }

  const browserWindow = window as Window & { [startupStateKey]?: StartupState };
  if (browserWindow[startupStateKey]) return browserWindow[startupStateKey]!;

  const state: StartupState = {
    snapshot: {
      navigationType: readNavigationType(),
      pathname: window.location.pathname,
    },
    signOutAttempted: false,
  };
  browserWindow[startupStateKey] = state;
  return state;
}

// This state lives on window so Vite HMR and React remounts cannot reinterpret an
// ordinary module update as a new document reload.
const startupState = readStartupState();

export function getStartupNavigationSnapshot(): StartupNavigationSnapshot {
  return startupState.snapshot;
}

export function stripBasePath(pathname: string, basePath: string): string {
  const normalizedBase = basePath.replace(/\/$/, '');
  if (!normalizedBase) return pathname || '/';
  if (pathname === normalizedBase) return '/';
  return pathname.startsWith(`${normalizedBase}/`) ? pathname.slice(normalizedBase.length) || '/' : pathname;
}

export function isWorkspacePath(pathname: string, basePath = ''): boolean {
  const routePath = stripBasePath(pathname, basePath);
  return new Set(['/dashboard', '/roster', '/voting', '/archive', '/approvals', '/members', '/activity']).has(routePath)
    || routePath.startsWith('/pnms/');
}

export function shouldSignOutOnReload(snapshot: StartupNavigationSnapshot, basePath = ''): boolean {
  return snapshot.navigationType === 'reload' && isWorkspacePath(snapshot.pathname, basePath);
}

export function claimReloadSignOutAttempt(): boolean {
  if (startupState.signOutAttempted) return false;
  startupState.signOutAttempted = true;
  return true;
}

export function releaseReloadSignOutAttempt(): void {
  startupState.signOutAttempted = false;
}