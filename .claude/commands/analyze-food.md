# /analyze-food — Food Image Analysis Skill

Analyse a food or drink photo (or a barcode photo) and return precise
KCAL / Protein / Carbs / Fat figures, then update the learning knowledge base.

---

## Usage

```
/analyze-food [path/to/image.jpg] [optional: "text note about the food"]
```

**Examples**
```
/analyze-food ~/Desktop/lunch.jpg
/analyze-food ~/Downloads/protein_shake.jpg "I added an extra scoop of whey"
/analyze-food ~/Photos/barcode.jpg "Alpro oat milk, about 300ml in the glass"
```

---

## What this skill does

1. **Reads** `food_analysis/knowledge.json` for calibration context (past items,
   user corrections, portion anchors)
2. **Determines** the meal type from the current time of day
3. **Integrates** any text/voice note you provide as ground truth
4. **Calls** the Claude Vision API with a structured multi-step prompt
5. **Displays** a formatted nutritional breakdown with confidence scores
6. **Offers** to log the result directly into today's tracker (`data.json`)
7. **Updates** the knowledge base so future analyses improve

---

## Steps

### 1 — Gather inputs

Ask the user:
- Path to the food image (required)
- Optional text note: e.g. *"two slices of sourdough, I skipped the butter"*

Read the image file. Read `food_analysis/knowledge.json`.

### 2 — Build the prompt

Load the prompt builder:
```bash
node -e "
const { buildFoodPrompt } = require('./food_analysis/prompt_builder.js');
const hour = new Date().getHours();
const knowledge = JSON.parse(require('fs').readFileSync('./food_analysis/knowledge.json','utf8'));
const { systemPrompt, userPrompt } = buildFoodPrompt({
  userNote: process.argv[1] || '',
  knowledge,
  hour,
});
console.log(JSON.stringify({ systemPrompt, userPrompt }));
" -- "$USER_NOTE"
```

### 3 — Call the Claude Vision API

Use the Anthropic API with `claude-opus-4-5` (vision model).
Pass `systemPrompt` as the system field, `userPrompt` as the text content,
and the image as a base64 `image` content block.

```bash
# Encode the image
IMAGE_B64=$(base64 -i "$IMAGE_PATH")
IMAGE_MIME=$(file --mime-type -b "$IMAGE_PATH")

# Call the API
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-4-5",
    "max_tokens": 1024,
    "system": "'"$SYSTEM_PROMPT"'",
    "messages": [{
      "role": "user",
      "content": [
        {
          "type": "image",
          "source": { "type": "base64", "media_type": "'"$IMAGE_MIME"'", "data": "'"$IMAGE_B64"'" }
        },
        { "type": "text", "text": "'"$USER_PROMPT"'" }
      ]
    }]
  }'
```

### 4 — Parse and display results

Parse the JSON response. Display a formatted summary:

```
┌─────────────────────────────────────────────────┐
│  🍽  MEAL ANALYSIS — [meal_type] · [time_label]  │
├──────────────────┬──────┬───────┬───────┬────────┤
│ Item             │ kcal │ Prot  │ Carbs │  Fat   │
├──────────────────┼──────┼───────┼───────┼────────┤
│ [item name]      │  xxx │  xx g │  xx g │  xx g  │
│  └ [quantity]    │      │       │       │        │
├──────────────────┼──────┼───────┼───────┼────────┤
│ TOTAL            │  xxx │  xx g │  xx g │  xx g  │
└──────────────────┴──────┴───────┴───────┴────────┘
Confidence: [overall_confidence × 100]%
Portions estimated via: [estimation_notes]
Tip: [improvement_hint]
```

### 5 — Offer to log the meal

Ask: *"Log this meal to today's tracker? (y/n)"*

If yes, read `data.json`, append the meal with today's date, recalculate totals,
write `data.json` back.

```json
{
  "name": "[meal summary]",
  "kcal": 0,
  "protein_g": 0,
  "carbs_g": 0,
  "fat_g": 0,
  "time": "[ISO timestamp]",
  "source": "analyze-food-skill",
  "confidence": 0.85
}
```

### 6 — Offer correction loop

Ask: *"Does the total look right? Enter corrected kcal if not, or press Enter to accept."*

If the user enters a corrected value, record a correction entry in
`food_analysis/knowledge.json` under `calibrations.entries`.

### 7 — Update the knowledge base

Regardless of corrections, append the analysis to `food_analysis/knowledge.json`:

- Add new or updated items to `known_items.entries` (deduplicate by name)
- Append to `analyses.entries` (trim to last 100)
- Update `_meta.last_updated` and `_meta.total_analyses`

Commit both `data.json` and `food_analysis/knowledge.json` with message:
`tracker: log meal + update food knowledge base [date]`

---

## Learning mechanism

Each analysis adds to the knowledge base in three ways:

| Store | What gets added | How it's used next time |
|---|---|---|
| `known_items` | Confirmed food → macros mapping | Injected into prompt as calibration anchors |
| `calibrations` | User-corrected estimates | Injected as "the model was wrong here — learn" |
| `analyses` | Full analysis log | Used to detect repeated meals (meal_patterns) |

After 5+ analyses of the same item the skill can auto-detect that you eat it
regularly and flag it as a **meal pattern** (e.g. "you have oat porridge most
mornings — last confirmed: 380 kcal").

---

## Flags

| Flag | Effect |
|---|---|
| `--no-learn` | Skip knowledge base update |
| `--verbose` | Show full JSON response, not just formatted table |
| `--barcode` | Hint to model that image contains a barcode label |
| `--voice "..."` | Treat the string as a voice transcription (same as text note) |
| `--correct` | Open correction mode for the most recent logged meal |

---

## Environment

Requires `ANTHROPIC_API_KEY` to be set (or stored in Settings → Anthropic API Key
in the web tracker).

The knowledge base at `food_analysis/knowledge.json` should be committed to the
repo so it persists and can be shared across devices via GitHub sync.
