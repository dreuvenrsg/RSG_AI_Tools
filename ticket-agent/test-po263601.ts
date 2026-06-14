// Quick test for PO263601 case
import './src/env.js';
import { normalizePO, calculatePOMatchConfidence } from './src/fulcrum';

console.log('Testing PO263601 edge case...\n');

const testCases = [
  ['PO263601', '263601'],
  ['po263601', '263601'],
  ['PO 263601', '263601'],
  ['PO-263601', '263601'],
];

testCases.forEach(([input, expected]) => {
  const normalized = normalizePO(input);
  const matches = normalized === expected;
  const confidence = calculatePOMatchConfidence(input, expected);

  console.log(`Input: "${input}"`);
  console.log(`  Normalized: "${normalized}"`);
  console.log(`  Expected: "${expected}"`);
  console.log(`  Match: ${matches ? '✓' : '✗'}`);
  console.log(`  Confidence: ${confidence}`);
  console.log('');
});
