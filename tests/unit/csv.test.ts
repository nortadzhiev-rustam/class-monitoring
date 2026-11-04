import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCsv } from '../../src/teacher/csv';

test('cells with commas, quotes and newlines are quoted', () => {
  assert.equal(toCsv([['Name', 'Note'], ['Smith, Jo', 'said "hi"\nthen left']]), '﻿Name,Note\r\n"Smith, Jo","said ""hi""\nthen left"\r\n');
});

test('student-typed formulas are neutralised', () => {
  assert.equal(toCsv([['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)', 'Ana']]), '﻿"\'=HYPERLINK(""x"")",\'+1,\'-2,\'@SUM(A1),Ana\r\n');
});
