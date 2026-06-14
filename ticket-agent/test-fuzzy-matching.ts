// Test script for fuzzy PO matching
import './src/env.js';
import { normalizePO, calculatePOMatchConfidence, PO_MATCH_CONFIDENCE_THRESHOLD } from './src/fulcrum';

console.log('='.repeat(80));
console.log('FUZZY PO MATCHING TEST');
console.log('='.repeat(80));

// Test cases: [customerPO, fulcrumPO, expectedMatch]
const testCases = [
  // Exact matches
  ['400203171', '400203171', true, 1.0],

  // Prefix variations (with and without space/dash)
  ['PO 400203171', '400203171', true, 0.95],
  ['PO-400203171', '400203171', true, 0.95],
  ['PO400203171', '400203171', true, 0.95],
  ['po 400203171', '400203171', true, 0.95],
  ['PO263601', '263601', true, 0.95],        // No space case
  ['po263601', '263601', true, 0.95],        // No space, lowercase

  // Suffix variations
  ['400203171-XP', '400203171', true, 0.95],
  ['400203171XP', '400203171', true, 0.95],
  ['400203171-xp', '400203171', true, 0.95],

  // Both prefix and suffix
  ['PO 400203171-XP', '400203171', true, 0.95],
  ['PO-400203171-XP', '400203171', true, 0.95],

  // Whitespace variations
  ['400 203 171', '400203171', true, 0.95],
  ['400-203-171', '400203171', true, 0.95],

  // Reversed: Fulcrum has formatting
  ['400203171', 'PO 400203171', true, 0.95],
  ['400203171', '400203171-XP', true, 0.95],
  ['400203171', 'PO-400203171-XP', true, 0.95],

  // Both sides have formatting
  ['PO 400203171', 'PO-400203171', true, 0.95],
  ['400203171-XP', '400203171 XP', true, 0.95],

  // Non-matches
  ['400203171', '400203172', false, 0.0],
  ['PO 123456', '654321', false, 0.0],
  ['', '400203171', false, 0.0],
  ['400203171', '', false, 0.0],
] as const;

console.log(`\nRunning ${testCases.length} test cases...\n`);

let passed = 0;
let failed = 0;

testCases.forEach(([customerPO, fulcrumPO, shouldMatch, expectedConfidence], index) => {
  const normalizedCustomer = normalizePO(customerPO);
  const normalizedFulcrum = normalizePO(fulcrumPO);
  const confidence = calculatePOMatchConfidence(customerPO, fulcrumPO);
  const meetsThreshold = confidence >= PO_MATCH_CONFIDENCE_THRESHOLD;
  const testPassed = meetsThreshold === shouldMatch && confidence === expectedConfidence;

  if (testPassed) {
    passed++;
    console.log(`✓ Test ${index + 1}: PASS`);
  } else {
    failed++;
    console.log(`✗ Test ${index + 1}: FAIL`);
  }

  console.log(`  Customer PO:    "${customerPO}" → "${normalizedCustomer}"`);
  console.log(`  Fulcrum PO:     "${fulcrumPO}" → "${normalizedFulcrum}"`);
  console.log(`  Confidence:     ${confidence} (expected: ${expectedConfidence})`);
  console.log(`  Meets Threshold: ${meetsThreshold} (expected: ${shouldMatch})`);
  console.log(`  Threshold:      ${PO_MATCH_CONFIDENCE_THRESHOLD}`);
  console.log('');
});

console.log('='.repeat(80));
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${testCases.length} tests`);
console.log('='.repeat(80));

if (failed > 0) {
  process.exit(1);
}
