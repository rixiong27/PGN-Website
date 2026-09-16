import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorkspacePath, shouldSignOutOnReload } from '../src/lib/reload-signout';

test('only a full reload of a chapter workspace route requests sign-out', () => {
  assert.equal(shouldSignOutOnReload({ navigationType: 'reload', pathname: '/dashboard' }), true);
  assert.equal(shouldSignOutOnReload({ navigationType: 'reload', pathname: '/pnms/42' }), true);
  assert.equal(shouldSignOutOnReload({ navigationType: 'navigate', pathname: '/dashboard' }), false);
  assert.equal(shouldSignOutOnReload({ navigationType: 'reload', pathname: '/sign-in' }), false);
});

test('preserves authentication and join callback routes', () => {
  assert.equal(isWorkspacePath('/join'), false);
  assert.equal(isWorkspacePath('/sign-in/sso-callback'), false);
  assert.equal(isWorkspacePath('/sign-up/sso-callback'), false);
  assert.equal(isWorkspacePath('/'), false);
});

test('matches workspace routes beneath the configured artifact base path', () => {
  assert.equal(isWorkspacePath('/pgn-recruitment/dashboard', '/pgn-recruitment'), true);
  assert.equal(isWorkspacePath('/pgn-recruitment/pnms/7', '/pgn-recruitment'), true);
  assert.equal(isWorkspacePath('/pgn-recruitment/join', '/pgn-recruitment'), false);
  assert.equal(isWorkspacePath('/other-app/dashboard', '/pgn-recruitment'), false);
});