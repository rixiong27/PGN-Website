import assert from 'node:assert/strict';
import test from 'node:test';
import { restorePendingApproval } from '../src/lib/pending-approvals';

type Approval = { id: number; name: string };

test('restores only the failed approval while preserving concurrent cache changes', () => {
  const failed = { id: 1, name: 'Failed' };
  const successful = { id: 2, name: 'Successful' };
  const stillPending = { id: 3, name: 'Still pending' };

  const restored = restorePendingApproval([stillPending], failed, 0);

  assert.deepEqual(restored, [failed, stillPending]);
  assert.equal(restored.some((member) => member.id === successful.id), false);
});

test('does not duplicate an approval already restored by reconciliation', () => {
  const approval: Approval = { id: 1, name: 'Already present' };
  assert.deepEqual(restorePendingApproval([approval], approval, 0), [approval]);
});