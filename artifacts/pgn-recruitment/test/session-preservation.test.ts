import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('does not sign out or clear session data as part of app startup', () => {
  assert.doesNotMatch(appSource, /ReloadSignOutGate|shouldSignOutOnReload|claimReloadSignOutAttempt|releaseReloadSignOutAttempt/);
  assert.match(appSource, /<Router \/><Toaster \/>/);
});

test('waits for Clerk and member authorization before rendering protected routes', () => {
  assert.match(appSource, /if \(!isLoaded \|\| \(isSignedIn && isLoading\)\) return <div className="auth-shell" \/>;/);
  assert.match(appSource, /if \(!isSignedIn\) return <Redirect to="\/" \/>;/);
  assert.match(appSource, /if \(isError\) return <Redirect to="\/join" \/>;/);
});

test('keeps user-initiated sign-out behavior separate from startup', () => {
  assert.match(appSource, /const handleSignOut = async \(\) => \{/);
  assert.match(appSource, /await signOut\(\{ redirectUrl: `\$\{basePath\}\/sign-in` \}\);/);
  assert.match(appSource, /queryClient\.clear\(\);/);
});

test('keeps nested workspace routes in the active router after reload', () => {
  assert.match(appSource, /<Route path="\/pnms\/:id"><ProtectedRoute>/);
  assert.match(appSource, /<Route path="\/voting" component=\{VotingRoute\} \/>/);
  assert.match(appSource, /<Route path="\/dashboard"><ProtectedRoute>/);
});