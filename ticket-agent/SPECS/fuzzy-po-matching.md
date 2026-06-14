# Fuzzy PO Number Matching Implementation

## Overview
Implemented bidirectional fuzzy matching for PO numbers to handle formatting variations between customer inputs and Fulcrum database entries.

## Problem Solved
**Before**: Exact string matching failed when PO numbers had different formatting:
- Customer ticket: `"PO 400203171"` or `"400203171-XP"`
- Fulcrum database: `"400203171"`
- Result: ❌ No match found

**After**: Fuzzy matching normalizes both sides before comparison:
- Customer ticket: `"PO 400203171"` → normalized to `"400203171"`
- Fulcrum database: `"400203171"` → normalized to `"400203171"`
- Result: ✅ Match found with 0.95 confidence

## Implementation Details

### 1. Normalization Function (`normalizePO()`)
**Location**: `lambdas/PoProcessor/src/fulcrum.ts:34-43`

Removes common formatting variations:
- **Case**: Converts to uppercase
- **Prefix**: Removes `"PO"` with optional space/dash (`PO `, `PO-`, `PO`)
- **Whitespace**: Removes all spaces and dashes
- **Suffix**: Removes `"XP"` (explosion-proof designation)

**Examples**:
```typescript
normalizePO("PO 400203171")     → "400203171"
normalizePO("400203171-XP")     → "400203171"
normalizePO("PO-400203171-XP")  → "400203171"
normalizePO("400 203 171")      → "400203171"
```

### 2. Confidence Scoring (`calculatePOMatchConfidence()`)
**Location**: `lambdas/PoProcessor/src/fulcrum.ts:53-67`

Returns confidence score (0.0 to 1.0):
- **1.0**: Perfect exact match (both strings identical)
- **0.95**: Normalized match (same core number, different formatting)
- **0.0**: No match

### 3. Confidence Threshold
**Location**: `lambdas/PoProcessor/src/fulcrum.ts:73`

```typescript
export const PO_MATCH_CONFIDENCE_THRESHOLD = 0.9;
```

Only matches with confidence ≥ 0.9 are returned. This filters out:
- Non-matches (confidence 0.0)
- Future low-confidence matches (e.g., typos with Levenshtein distance)

### 4. Updated Functions

#### `findSalesOrdersByPO()`
**Location**: `lambdas/PoProcessor/src/fulcrum.ts:173-183`

**Changes**:
- Normalizes search PO before fetching
- Applies `calculatePOMatchConfidence()` to each order
- Filters out matches below threshold
- Logs normalized values and confidence scores

**Before**:
```typescript
const batchMatches = orders.filter(o => o.customerPoNumber === customerPoNumber);
```

**After**:
```typescript
const batchMatches = orders.filter(o => {
  const confidence = calculatePOMatchConfidence(customerPoNumber, o.customerPoNumber || '');

  if (confidence >= PO_MATCH_CONFIDENCE_THRESHOLD) {
    const normalizedOrderPO = normalizePO(o.customerPoNumber);
    console.log(`[Fuzzy Match] ✓ Matched: "${o.customerPoNumber}" (normalized: "${normalizedOrderPO}") with confidence ${confidence}`);
    return true;
  }

  return false;
});
```

#### `trackOrder()`
**Location**: `lambdas/PoProcessor/src/order-tracking.ts:44-56`

**Changes**:
- Imports fuzzy matching utilities
- Applies confidence threshold filter (defense-in-depth)
- Logs normalized values and confidence scores

**Before**:
```typescript
const exactMatches = salesOrders.filter(
  order => order.customerPoNumber === poNumber
);
```

**After**:
```typescript
const highConfidenceMatches = salesOrders.filter(order => {
  const confidence = calculatePOMatchConfidence(poNumber, order.customerPoNumber || '');

  if (confidence >= PO_MATCH_CONFIDENCE_THRESHOLD) {
    const normalizedOrderPO = normalizePO(order.customerPoNumber);
    console.log(`[OrderTracking] ✓ High confidence match: "${order.customerPoNumber}" (normalized: "${normalizedOrderPO}") - confidence: ${confidence}`);
    return true;
  }

  console.log(`[OrderTracking] ✗ Low confidence match (${confidence}): "${order.customerPoNumber}" - filtering out`);
  return false;
});
```

## Testing

### Unit Tests
**File**: `lambdas/PoProcessor/test-fuzzy-matching.ts`

**Coverage**: 21 test cases covering:
- Exact matches (1.0 confidence)
- Prefix variations (`PO `, `PO-`, `po `)
- Suffix variations (`-XP`, `XP`)
- Combined variations
- Whitespace variations
- Bidirectional matching (customer vs Fulcrum formatting)
- Non-matches (different PO numbers, empty strings)

**Results**: ✅ **21/21 tests passed**

### Integration Tests
**File**: `lambdas/PoProcessor/test-fuzzy-fulcrum.ts`

**Tests**: Real Fulcrum API calls with PO `400203171` using 6 different formats:
- `"400203171"` → ✅ Found order #6273 (1.0 confidence)
- `"PO 400203171"` → ✅ Found order #6273 (0.95 confidence)
- `"PO-400203171"` → ✅ Found order #6273 (0.95 confidence)
- `"400203171-XP"` → ✅ Found order #6273 (0.95 confidence)
- `"PO 400203171-XP"` → ✅ Found order #6273 (0.95 confidence)
- `"400 203 171"` → ✅ Found order #6273 (0.95 confidence)

**Results**: All formats successfully matched the same order

## Benefits

✅ **Handles Formatting Variations**: Works regardless of how customer or Fulcrum formats the PO
✅ **Bidirectional**: Normalizes both input and database values
✅ **Conservative**: Only removes known formatting (no aggressive fuzzy matching)
✅ **Transparent**: Comprehensive logging for debugging
✅ **Backward Compatible**: Exact matches still return 1.0 confidence
✅ **Safe**: Confidence threshold prevents false positives
✅ **Extensible**: Framework ready for future enhancements (Levenshtein distance, etc.)

## Edge Cases Handled

| Customer Input | Fulcrum Database | Match? | Confidence |
|----------------|------------------|--------|------------|
| `400203171` | `400203171` | ✅ Yes | 1.0 |
| `PO 400203171` | `400203171` | ✅ Yes | 0.95 |
| `400203171-XP` | `400203171` | ✅ Yes | 0.95 |
| `PO-400203171-XP` | `400203171` | ✅ Yes | 0.95 |
| `400203171` | `PO 400203171` | ✅ Yes | 0.95 |
| `400 203 171` | `400203171` | ✅ Yes | 0.95 |
| `400203171` | `400203172` | ❌ No | 0.0 |
| `""` | `400203171` | ❌ No | 0.0 |

## Logging Examples

**Successful Match**:
```
[Fulcrum] Searching for PO: "PO 400203171" (normalized: "400203171")
[Fuzzy Match] ✓ Matched: "400203171" (normalized: "400203171") with confidence 0.95
[OrderTracking] ✓ High confidence match: "400203171" (normalized: "400203171") - confidence: 0.95
```

**No Match**:
```
[Fulcrum] Searching for PO: "400203171" (normalized: "400203171")
[Fulcrum] Search complete: 0 order(s) found for PO "400203171" after checking 1000 orders
[OrderTracking] No sales order found for PO: 400203171
```

## Files Modified

1. **`lambdas/PoProcessor/src/fulcrum.ts`**
   - Added `normalizePO()` (exported)
   - Added `calculatePOMatchConfidence()` (exported)
   - Added `PO_MATCH_CONFIDENCE_THRESHOLD` constant (exported)
   - Updated `findSalesOrdersByPO()` filter logic

2. **`lambdas/PoProcessor/src/order-tracking.ts`**
   - Imported fuzzy matching utilities
   - Updated `trackOrder()` filter logic

3. **Test Files** (new):
   - `test-fuzzy-matching.ts` - Unit tests
   - `test-fuzzy-fulcrum.ts` - Integration tests
   - `SPECS/fuzzy-po-matching.md` - This documentation

## Future Enhancements

The framework is ready for:
- **Levenshtein distance**: Handle typos (e.g., `400203171` vs `400203171` - transposed digit)
- **Partial matching**: Support shorter PO numbers
- **Custom confidence thresholds**: Per-customer or per-context thresholds
- **Machine learning**: Learn from user corrections

## Performance Impact

**Minimal overhead**:
- Normalization: O(n) string operations on small strings (~10-20 chars)
- Confidence calculation: 2× normalization + string comparison
- Early-exit optimization: Stops after finding match (existing behavior preserved)
- Total added time: <1ms per PO comparison

**Real-world timing** (from integration test):
- First match (plain format): 5219ms (10 batches = 1000 orders checked)
- Subsequent matches: 1570-1932ms (cache benefits)
- Same performance as before (comparison overhead negligible vs API calls)
