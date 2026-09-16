import assert from 'node:assert/strict';
import test from 'node:test';

import { toPnmInput } from '../src/lib/pnm-form';

test('converts blank optional fields to null API values', () => {
  assert.deepEqual(toPnmInput({
    firstName: '  Jordan ',
    lastName: ' Lee ',
    email: '',
    major: ' Marketing ',
    year: 'Junior',
    semester: 'Fall 2026',
  }), {
    firstName: 'Jordan',
    lastName: 'Lee',
    email: null,
    major: 'Marketing',
    year: 'Junior',
    semester: 'Fall 2026',
  });
});

test('does not submit whitespace-only names', () => {
  assert.equal(toPnmInput({
    firstName: ' ',
    lastName: 'Lee',
    email: '',
    major: '',
    year: 'Freshman',
    semester: 'Fall 2026',
  }), null);
});