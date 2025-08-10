/**
 * QuickBid MVP server
 * - Serves static frontend from /public
 * - POST /api/estimate  => compute estimate (optionally call OpenAI to generate proposal)
 * - GET  /api/estimates => list saved estimates
 *
 * Storage: data/estimates.json (simple JSON file)
 *
 * Assumptions & defaults are in computeEstimateDefaults()
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const ESTIMATES_FILE = path.join(DATA_DIR, 'estimates.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(ESTIMATES_FILE)) fs.writeFileSync(ESTIMATES_FILE, JSON.stringify([]));

// Utility to read/save estimates
function readEstimates() {
  try {
    return JSON.parse(fs.readFileSync(ESTIMATES_FILE, 'utf8') || '[]');
  } catch (e) {
    return [];
  }
}
function writeEstimates(list) {
  fs.writeFileSync(ESTIMATES_FILE, JSON.stringify(list, null, 2));
}

function computeEstimateDefaults() {
  // Defaults chosen for an MVP; users should adjust to local market.
  return {
    price_per_cy: 140.0,          // USD per cubic yard (default)
    rebar_cost_per_sqft: 1.25,   // USD per sqft for rebar (grid + install)
    labor_rate_per_hour: 60.0,   // USD per labor hour
    labor_hours_per_sqft: 0.02,  // hours per sqft (0.02 => 20 hrs per 1000 sqft)
    forms_cost_per_sqft: 1.50,   // forming/set/strip per sqft
    tearout_cost_per_sqft: 3.50, // disposal/tearout per sqft
    overhead_pct: 0.15,          // overhead as fraction of subtotal
    profit_pct: 0.12             // profit margin
  };
}

// Core estimation logic
function computeEstimate(params) {
  const d = computeEstimateDefaults();

  // extract user-supplied or default values
  const width = Number(params.width_ft || 0);
  const length = Number(params.length_ft || 0);
  const thickness_in = Number(params.thickness_in || 4); // default 4"
  const area_sqft = +(width * length).toFixed(2);

  const thickness_ft = thickness_in / 12.0;
  const volume_cy = +((area_sqft * thickness_ft) / 27.0).toFixed(3); // cubic yards

  const price_per_cy = Number(params.price_per_cy || d.price_per_cy);
  const concrete_cost = +(volume_cy * price_per_cy).toFixed(2);

  const rebar_cost_per_sqft = Number(params.rebar_cost_per_sqft || d.rebar_cost_per_sqft);
  const rebar_cost = +(area_sqft * rebar_cost_per_sqft).toFixed(2);

  const forms_cost_per_sqft = Number(params.forms_cost_per_sqft || d.forms_cost_per_sqft);
  const forms_cost = +(area_sqft * forms_cost_per_sqft).toFixed(2);

  const labor_rate = Number(params.labor_rate_per_hour || d.labor_rate_per_hour);
  const labor_hours_per_sqft = Number(params.labor_hours_per_sqft || d.labor_hours_per_sqft);
  const labor_hours = +(area_sqft * labor_hours_per_sqft).toFixed(2);
  const labor_cost = +(labor_hours * labor_rate).toFixed(2);

  const tearout = params.tearout === true || params.tearout === 'true';
  const tearout_cost_per_sqft = Number(params.tearout_cost_per_sqft || d.tearout_cost_per_sqft);
  const tearout_cost = tearout ? +(area_sqft * tearout_cost_per_sqft).toFixed(2) : 0;

  const other_materials = Number(params.other_materials || 0);

  const subtotal = +(concrete_cost + rebar_cost + forms_cost + other_materials + labor_cost + tearout_cost).toFixed(2);
  const overhead = +(subtotal * Number(params.overhead_pct ?? d.overhead_pct)).toFixed(2);
  const profit = +((subtotal + overhead) * Number(params.profit_pct ?? d.profit_pct)).toFixed(2);
  const total = +(subtotal + overhead + profit).toFixed(2);

  return {
    inputs: {
      width_ft: width,
      length_ft: length,
      area_sqft,
      thickness_in,
      volume_cy
    },
    line_items: {
      concrete_cost,
      rebar_cost,
      forms_cost,
      other_materials,
      labor_hours,
      labor_cost,
      tearout_cost
    },
    summary: {
      subtotal,
      overhead,
      profit,
      total
    },
    params: {
      price_per_cy,
      rebar_cost_per_sqft,
      forms_cost_per_sqft,
      labor_rate,
      labor_hours_per_sqft,
      tearout_cost_per_sqft,
      overhead_pct: Number(params.overhead_pct ?? d.overhead_pct),
      profit_pct: Number(params.profit_pct ?? d.profit_pct)
    }
  };
}

// Optional: generate proposal text via OpenAI Chat Completion (if API key set)
async function generateProposalText(estimate, client_name = "Client") {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return null;
  }

  const prompt = `You are a professional contractor. Create a concise customer-facing proposal for ${client_name} based on the following estimate. Include a short Scope, Line items (with amounts), Timeline, Payment terms, and a short upsell (control joints / sealant). Keep it polite and easy to read.

Estimate JSON:
${JSON.stringify(estimate, null, 2)}
`;

  try {
    // Chat Completions endpoint (using gpt-4o-mini / adjust model as needed)
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // change if needed
        messages: [
          { role: 'system', content: 'You are an expert construction estimator and proposal writer.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 600,
        temperature: 0.2
      })
    });

    if (!res.ok) {
      const txt = await res.text();
      console.warn('OpenAI error', res.status, txt);
      return null;
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || null;
    return msg;
  } catch (e) {
    console.warn('OpenAI call failed', e && e.message);
    return null;
  }
}

// Routes

app.get('/api/health', (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.post('/api/estimate', async (req, res) => {
  try {
    const payload = req.body || {};
    const estimate = computeEstimate(payload);

    // If user asked to generate proposal text and we have an API key, call OpenAI
    let proposal = null;
    if (payload.generate_proposal) {
      proposal = await generateProposalText({ estimate, client_name: payload.client_name || "Client" });
    }

    const id = uuidv4();
    const record = {
      id,
      created_at: new Date().toISOString(),
      client_name: payload.client_name || null,
      params: payload,
      estimate
    };
    // Save record
    const list = readEstimates();
    list.unshift(record); // newest first
    writeEstimates(list);

    res.json({ ok: true, id, estimate, proposal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get('/api/estimates', (req, res) => {
  const list = readEstimates();
  res.json({ ok: true, items: list.slice(0, 50) }); // return recent 50
});

// Fallback to index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`QuickBid MVP listening on http://localhost:${PORT}`);
});
