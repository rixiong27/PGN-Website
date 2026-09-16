import type { ReactNode } from 'react';

export function ClerkProvider({ children }: { children: ReactNode }) {
  return children;
}

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: true,
    getToken: async () => 'browser-test-token',
  };
}

export function useClerk() {
  return {
    signOut: async () => undefined,
  };
}

export function SignIn() {
  return null;
}

export function SignUp() {
  return null;
}

export function Show({ children }: { children: ReactNode }) {
  return children;
}

export function publishableKeyFromHost(_hostname: string, fallback?: string) {
  return fallback ?? 'pk_test_browser_route_check';
}