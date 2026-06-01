/**
 * Food Analysis Prompt Builder
 * ─────────────────────────────────────────────────────────────────────────
 * Shared module used by both:
 *  - The Claude Code skill  (.claude/commands/analyze-food.md)
 *  - The web app            (index.html → analysePhoto())
 *
 * Usage (browser):
 *   <script src="food_analysis/prompt_builder.js"></script>
 *   const { systemPrompt, userPrompt } = buildFoodPrompt({ userNote, knowledge });
 *
 * Usage (Node / skill):
 *   const { buildFoodPrompt } = require('./food_analysis/prompt_builder.js');
 */

// ── Meal-time mapping ──────────────────────────────────────────────────────
function getMealContext(hour) {
  if (hour === null || hour === undefined) return { meal: 'meal', label: 'unknown time' };
  if (hour >= 5  && hour < 10) return { meal: 'breakfast', label: `morning (${hour}:00)` };
  if (hour >= 10 && hour < 12) return { meal: 'brunch',    label: `late morning (${hour}:00)` };
  if (hour >= 12 && hour < 14) return { meal: 'lunch',     label: `midday (${hour}:00)` };
  if (hour >= 14 && hour < 17) return { meal: 'snack',     label: `afternoon (${hour}:00)` };
  if (hour >= 17 && hour < 21) return { meal: 'dinner',    label: `evening (${hour}:00)` };
  return { meal: 'late snack', label: `late night (${hour}:00)` };
}

// ── Build calibration context from knowledge base ──────────────────────────
function buildCalibrationContext(knowledge) {
  if (!knowledge) return '';
  const lines = [];

  // Inject up to 8 recently confirmed items as reference
  const known = (knowledge.known_items?.entries || []).slice(-8);
  if (known.length) {
    lines.push('KNOWN ITEMS FROM PAST ANALYSES (use as calibration anchors):');
    known.forEach(item => {
      lines.push(`  • ${item.name} — ${item.serving}: ${item.kcal} kcal, P ${item.protein_g}g, C ${item.carbs_g}g, F ${item.fat_g}g (confidence: ${item.confidence})`);
    });
  }

  // Inject up to 8 user corrections so the model learns from mistakes
  const corrections = (knowledge.calibrations?.entries || []).slice(-8);
  if (corrections.length) {
    lines.push('\nUSER CORRECTIONS (learn from these — the model was wrong before):');
    corrections.forEach(c => {
      const kcalNote = (c.estimated_kcal && c.actual_kcal)
        ? `estimated ${c.estimated_kcal} kcal → actual ${c.actual_kcal} kcal` : '';
      const freeText = c.correction_text || c.note || '';
      const detail = [kcalNote, freeText].filter(Boolean).join(' — ');
      lines.push(`  • ${c.date} | ${c.food}: ${detail}`);
    });
  }

  // Inject portion anchors always
  const anchors = knowledge.portion_anchors?.examples || [];
  if (anchors.length) {
    lines.push('\nPORTION REFERENCE OBJECTS (if visible, use for size estimation):');
    anchors.forEach(a => {
      const detail = a.volume_ml ? `≈ ${a.volume_ml} ml` : a.area_cm2 ? `≈ ${a.area_cm2} cm²` : '';
      lines.push(`  • ${a.object}${detail ? ' ('+detail+')' : ''}${a.note ? ' — '+a.note : ''}`);
    });
  }

  return lines.join('\n');
}

// ── System prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert nutritionist and food analyst with deep knowledge of:
- Culinary portion sizes across global cuisines
- Food density and weight estimation from visual cues
- Barcode/packaging label reading and nutritional extraction
- Volume-to-weight conversions for common foods
- The effect of cooking methods on nutritional content (raw vs cooked weight)

Your task is to analyse food images with high precision. You ALWAYS:
1. Use every visible reference object (plates, cutlery, hands, packaging, bottles) to calibrate portions
2. Account for cooking method (e.g. cooked rice vs raw, oil absorbed during frying)
3. Separate mixed dishes into estimated components
4. State your confidence and reasoning transparently
5. Return ONLY a valid JSON object — no markdown, no explanations outside the JSON

When a barcode is visible, prioritise the nutrition label data on the packaging over visual estimation.
When the user provides a text note, treat it as ground truth for items or quantities they describe.`;

// ── Main builder ───────────────────────────────────────────────────────────
function buildFoodPrompt({ userNote = '', knowledge = null, hour = null, imageDescription = '' }) {
  const { meal, label } = getMealContext(hour !== null ? hour : new Date().getHours());
  const calibration    = buildCalibrationContext(knowledge);

  const userPrompt = `
CONTEXT
───────
Time of day: ${label} → likely a ${meal}
${userNote ? `User note: "${userNote}"` : 'No additional user note provided.'}
${imageDescription ? `Image description hint: ${imageDescription}` : ''}

${calibration ? calibration + '\n' : ''}
ANALYSIS INSTRUCTIONS
─────────────────────
Step 1 — IDENTIFY
  List every food and drink item visible, including condiments, sauces, oils.
  If a barcode is visible, read the product name and use label data directly.

Step 2 — REFERENCE & PORTION
  Scan for reference objects (plate, cutlery, hand, glass, bottle, packaging).
  Use them to estimate the dimensions and weight of each food item.
  Apply standard food densities where needed (e.g. cooked rice ≈ 0.9 g/ml).

Step 3 — NUTRITIONAL CALCULATION
  For each item, calculate kcal, protein, carbs, fat, fibre, sugar.
  Use cooked/as-eaten weights (not raw).
  Note the cooking method if it affects nutrition (fried, boiled, grilled…).

Step 4 — CONFIDENCE & NOTES
  Assign per-item confidence (0–1). Flag anything uncertain.

OUTPUT FORMAT — return ONLY this JSON, no other text:
{
  "meal_type": "${meal}",
  "time_label": "${label}",
  "items": [
    {
      "name": "food name",
      "quantity_desc": "e.g. 1 slice (approx 80g)",
      "weight_g": 80,
      "cooking_method": "grilled | fried | raw | boiled | baked | none",
      "kcal": 0,
      "protein_g": 0,
      "carbs_g": 0,
      "fat_g": 0,
      "fiber_g": 0,
      "sugar_g": 0,
      "confidence": 0.85,
      "estimation_basis": "compared to standard 26cm plate, occupied ~1/4"
    }
  ],
  "totals": {
    "kcal": 0,
    "protein_g": 0,
    "carbs_g": 0,
    "fat_g": 0,
    "fiber_g": 0,
    "sugar_g": 0
  },
  "reference_objects_found": ["dinner plate", "fork"],
  "barcode_detected": false,
  "overall_confidence": 0.8,
  "estimation_notes": "Brief description of how portions were estimated",
  "improvement_hint": "What additional info would improve accuracy next time (e.g. include a coin for scale)"
}`.trim();

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}

// ── Learning: build updated knowledge entry after a confirmed analysis ──────
function buildKnowledgeEntry({ items, totals, date, mealType, confidence, userNote }) {
  return {
    id:         Date.now(),
    date:       date || new Date().toISOString().split('T')[0],
    meal_type:  mealType,
    user_note:  userNote || '',
    totals,
    items:      items.map(i => ({
      name:       i.name,
      weight_g:   i.weight_g,
      serving:    i.quantity_desc,
      kcal:       i.kcal,
      protein_g:  i.protein_g,
      carbs_g:    i.carbs_g,
      fat_g:      i.fat_g,
      confidence: i.confidence,
    })),
    overall_confidence: confidence,
  };
}

// ── Learning: build a user correction record ───────────────────────────────
function buildCorrectionEntry({ food, estimatedKcal, actualKcal, note }) {
  return {
    date:            new Date().toISOString().split('T')[0],
    food,
    estimated_kcal:  estimatedKcal,
    actual_kcal:     actualKcal,
    delta_pct:       Math.round((actualKcal - estimatedKcal) / estimatedKcal * 100),
    note:            note || '',
  };
}

// ── Export (works in both Node and browser global scope) ───────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildFoodPrompt, buildKnowledgeEntry, buildCorrectionEntry, getMealContext };
} else {
  window.FoodPrompt = { buildFoodPrompt, buildKnowledgeEntry, buildCorrectionEntry, getMealContext };
}
