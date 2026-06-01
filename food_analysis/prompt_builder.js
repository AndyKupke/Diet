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

// ── Cluster corrections into error categories ──────────────────────────────
function clusterCorrections(corrections) {
  const clusters = {
    weight:   [],   // portion / gram weight errors
    missing:  [],   // items the model failed to detect at all
    content:  [],   // wrong ingredient, macro, or cooking-method errors
    kcal:     [],   // explicit calorie-value corrections
    other:    [],
  };

  corrections.forEach(c => {
    const t = (c.correction_text || c.note || '').toLowerCase();
    const hasKcalDelta = c.estimated_kcal && c.actual_kcal &&
                         Math.abs(c.estimated_kcal - c.actual_kcal) > 30;

    // Priority order matters — a correction can match multiple but goes into first match
    if (/miss|forgot|also had|didn.t include|not included|additional|extra item|left out|overlooked/.test(t)) {
      clusters.missing.push(c);
    } else if (/\d+\s*g\b|gram|portion|serving|heavier|lighter|bigger|smaller|more.*rice|less.*chicken|too (much|little)|half|double/.test(t)) {
      clusters.weight.push(c);
    } else if (/protein|carb|fat|macro|ingredient|oil|butter|dressing|sauce|sugar|cream|milk|cheese|fried|deep.fry|cooked in/.test(t)) {
      clusters.content.push(c);
    } else if (hasKcalDelta || /kcal|calorie|closer to \d/.test(t)) {
      clusters.kcal.push(c);
    } else {
      clusters.other.push(c);
    }
  });

  return clusters;
}

// ── Detect recurring patterns across clusters ──────────────────────────────
function detectPatterns(clusters, allCorrections) {
  const insights = [];

  // ── Calorie bias: are estimates systematically off in one direction? ──────
  const withBoth = allCorrections.filter(c => c.estimated_kcal && c.actual_kcal);
  if (withBoth.length >= 2) {
    const deltas   = withBoth.map(c => c.actual_kcal - c.estimated_kcal);
    const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const avgPct   = withBoth.reduce((s, c) => s + (c.actual_kcal - c.estimated_kcal) / c.estimated_kcal * 100, 0) / withBoth.length;
    const allUnder = deltas.every(d => d > 0);
    const allOver  = deltas.every(d => d < 0);
    if (Math.abs(avgDelta) > 40) {
      const dir   = avgDelta > 0 ? 'underestimating' : 'overestimating';
      const arrow = avgDelta > 0 ? '↑' : '↓';
      insights.push(`SYSTEMATIC CALORIE BIAS ${arrow}: You are consistently ${dir} by ~${Math.round(Math.abs(avgPct))}% (avg ${Math.round(Math.abs(avgDelta))} kcal per meal across ${withBoth.length} corrections). Adjust all estimates in this direction.`);
    }
  }

  // ── Portion/weight patterns ───────────────────────────────────────────────
  if (clusters.weight.length >= 1) {
    // Which specific foods keep getting weight-corrected?
    const foods = clusters.weight.map(c => c.food).filter(Boolean);
    const uniqueFoods = [...new Set(foods)];
    // Check for "consistently underweighted" vs "overweighted"
    const underTexts = clusters.weight.filter(c =>
      /(more|heavier|bigger|too little|larger|double|\d+ ?g.* not \d+ ?g)/.test((c.correction_text||'').toLowerCase())
    );
    const overTexts = clusters.weight.filter(c =>
      /(less|lighter|smaller|too much|half)/.test((c.correction_text||'').toLowerCase())
    );
    if (underTexts.length > overTexts.length) {
      insights.push(`PORTION UNDERESTIMATION PATTERN: You tend to underestimate portion weights. Foods repeatedly corrected: ${uniqueFoods.join(', ')}. Lean towards larger estimates.`);
    } else if (overTexts.length > underTexts.length) {
      insights.push(`PORTION OVERESTIMATION PATTERN: You tend to overestimate portion weights for: ${uniqueFoods.join(', ')}. Lean towards smaller estimates.`);
    } else if (uniqueFoods.length) {
      insights.push(`PORTION SIZING ERRORS: Portion weight was corrected for: ${uniqueFoods.join(', ')}. Pay extra attention to weight estimation for these foods.`);
    }
  }

  // ── Missing item patterns ─────────────────────────────────────────────────
  if (clusters.missing.length >= 1) {
    const texts = clusters.missing.map(c => (c.correction_text || '').toLowerCase());
    const oilFatCount    = texts.filter(t => /oil|fat|butter|dressing|mayo|cream|ghee|lard/.test(t)).length;
    const condimentCount = texts.filter(t => /sauce|ketchup|mustard|vinegar|soy|sriracha|hot sauce/.test(t)).length;
    const sideCount      = texts.filter(t => /side|salad|bread|rice|pasta|extra/.test(t)).length;
    const drinkCount     = texts.filter(t => /drink|juice|coffee|milk|tea|water/.test(t)).length;

    const missedTypes = [];
    if (oilFatCount > 0)    missedTypes.push(`cooking fats/oils/dressings (${oilFatCount}x)`);
    if (condimentCount > 0) missedTypes.push(`condiments/sauces (${condimentCount}x)`);
    if (sideCount > 0)      missedTypes.push(`side dishes (${sideCount}x)`);
    if (drinkCount > 0)     missedTypes.push(`drinks (${drinkCount}x)`);

    if (missedTypes.length) {
      insights.push(`RECURRING MISSED ITEMS: The following categories are repeatedly overlooked: ${missedTypes.join(', ')}. Always scan the entire frame and explicitly account for these.`);
    } else {
      insights.push(`MISSING ITEM PATTERN: Items were missed in ${clusters.missing.length} past analyses. Be thorough — check for hidden components on the plate and outside the main dish.`);
    }
  }

  // ── Content / ingredient patterns ────────────────────────────────────────
  if (clusters.content.length >= 1) {
    const texts = clusters.content.map(c => (c.correction_text || '').toLowerCase());
    const oilFrying  = texts.filter(t => /oil|fry|deep.fry|sauté|cooked in/.test(t)).length;
    const dairyFat   = texts.filter(t => /cream|butter|cheese|milk|yogurt/.test(t)).length;
    const macroWrong = texts.filter(t => /protein|carb|fat|macro/.test(t)).length;

    if (oilFrying >= 1) {
      insights.push(`COOKING FAT UNDERESTIMATION: Oil absorption from frying/sautéing has been underestimated ${oilFrying}x. Add 10–30g oil per portion for pan-fried items.`);
    }
    if (dairyFat >= 1) {
      insights.push(`DAIRY/FAT CONTENT: Dairy fat content (cream, butter, cheese) has been miscalculated ${dairyFat}x. Use full-fat values unless clearly skimmed.`);
    }
    if (macroWrong >= 1) {
      insights.push(`MACRO ACCURACY: Macro breakdown was incorrect in ${macroWrong} past analyses. Double-check protein/carb/fat split, especially for mixed dishes.`);
    }
  }

  return insights;
}

// ── Build calibration context from knowledge base ──────────────────────────
function buildCalibrationContext(knowledge) {
  if (!knowledge) return '';
  const lines = [];

  // ── Known confirmed items ─────────────────────────────────────────────────
  const known = (knowledge.known_items?.entries || []).slice(-8);
  if (known.length) {
    lines.push('KNOWN ITEMS FROM PAST ANALYSES (use as calibration anchors):');
    known.forEach(item => {
      lines.push(`  • ${item.name} — ${item.serving}: ${item.kcal} kcal, P ${item.protein_g}g, C ${item.carbs_g}g, F ${item.fat_g}g (confidence: ${item.confidence})`);
    });
  }

  // ── Clustered correction patterns ─────────────────────────────────────────
  const allCorrections = knowledge.calibrations?.entries || [];
  if (allCorrections.length) {
    const clusters  = clusterCorrections(allCorrections);
    const patterns  = detectPatterns(clusters, allCorrections);

    if (patterns.length) {
      lines.push('\nLEARNED PATTERNS FROM USER CORRECTIONS (apply these rules to every analysis):');
      patterns.forEach(p => lines.push(`  ⚠ ${p}`));
    }

    // Inject the 3 most recent corrections from each non-empty cluster as concrete examples
    lines.push('\nRECENT CORRECTION EXAMPLES BY CATEGORY:');
    const cats = [
      { key: 'missing', label: 'Missing items' },
      { key: 'weight',  label: 'Portion weight errors' },
      { key: 'content', label: 'Content/ingredient errors' },
      { key: 'kcal',    label: 'Calorie corrections' },
      { key: 'other',   label: 'Other corrections' },
    ];
    let anyExamples = false;
    cats.forEach(({ key, label }) => {
      const entries = clusters[key].slice(-3);
      if (!entries.length) return;
      anyExamples = true;
      lines.push(`  [${label}]`);
      entries.forEach(c => {
        const kcalNote = (c.estimated_kcal && c.actual_kcal)
          ? `est. ${c.estimated_kcal} kcal → actual ${c.actual_kcal} kcal` : '';
        const freeText = c.correction_text || c.note || '';
        const detail   = [kcalNote, freeText].filter(Boolean).join(' | ');
        lines.push(`    • ${c.date} | ${c.food}: ${detail}`);
      });
    });
    if (!anyExamples) lines.pop(); // remove the header if no examples
  }

  // ── Portion reference objects ─────────────────────────────────────────────
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
const SYSTEM_PROMPT = `You are an expert nutritionist, food analyst and health coach with deep knowledge of:
- Culinary portion sizes across global cuisines
- Food density and weight estimation from visual cues
- Barcode/packaging label reading and nutritional extraction
- Volume-to-weight conversions for common foods
- The effect of cooking methods on nutritional content (raw vs cooked weight)
- Nutritional quality, food processing levels (NOVA classification), harmful ingredients
- Inflammatory foods, trans fats, ultra-processed additives, glycaemic impact, micronutrient density

Your task is to analyse food images with high precision. You ALWAYS:
1. Use every visible reference object (plates, cutlery, hands, packaging, bottles) to calibrate portions
2. Account for cooking method (e.g. cooked rice vs raw, oil absorbed during frying)
3. Separate mixed dishes into estimated components
4. State your confidence and reasoning transparently
5. Assess the overall healthiness of the meal objectively and flag any concerning ingredients
6. Return ONLY a valid JSON object — no markdown, no explanations outside the JSON

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

Step 5 — HEALTH ASSESSMENT
  Evaluate the overall healthiness of the entire meal. Consider:
  - Processing level: is food whole/minimally processed or ultra-processed (NOVA 3–4)?
  - Fat quality: are there trans fats, excessive saturated fat, or harmful frying oils?
  - Sugar load: added sugars, refined carbohydrates, high glycaemic impact?
  - Micronutrient density vs empty calories
  - Presence of beneficial components: fibre, antioxidants, omega-3, vegetables, lean protein
  - Additives, preservatives, artificial ingredients
  - Sodium content
  List every health concern found ("red flags") and every positive aspect ("green flags").
  Assign a health_score from 1.0 (extremely unhealthy/dangerous) to 10.0 (optimally healthy).
  Scoring guide:
    1–2: Highly processed, trans fats, excessive sugar/salt, nearly zero nutritional value
    3–4: Predominantly junk food, fast food, heavy frying, lots of refined carbs
    5–6: Mixed — some healthy elements but notable concerns (e.g. white rice + fried protein)
    7–8: Mostly healthy — whole foods, good macros, minor concerns only
    9–10: Excellent — whole foods, balanced macros, high micronutrient density, minimal processing

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
  "improvement_hint": "What additional info would improve accuracy next time (e.g. include a coin for scale)",
  "health_assessment": {
    "health_score": 7.5,
    "red_flags": [
      "Refined white rice — high glycaemic index, low fibre",
      "Deep-fried coating — likely trans fats from reused oil"
    ],
    "green_flags": [
      "Lean chicken breast — high protein, low saturated fat",
      "Mixed vegetables — fibre, vitamins, antioxidants"
    ],
    "summary": "One-sentence overall health verdict"
  }
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
  module.exports = { buildFoodPrompt, buildKnowledgeEntry, buildCorrectionEntry, getMealContext, clusterCorrections, detectPatterns };
} else {
  window.FoodPrompt = { buildFoodPrompt, buildKnowledgeEntry, buildCorrectionEntry, getMealContext, clusterCorrections, detectPatterns };
}
