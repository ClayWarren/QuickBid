// Lightweight frontend logic: submits form, renders breakdown and history
async function $(sel) { return document.querySelector(sel); }

function formatUSD(n) {
  return (typeof n === 'number' ? n : parseFloat(n||0)).toLocaleString('en-US', { style:'currency', currency:'USD', maximumFractionDigits:2 });
}

async function loadHistory() {
  const resEl = await $('#history');
  try {
    const res = await fetch('/api/estimates');
    const data = await res.json();
    if (!data.ok) { resEl.innerText = 'Unable to load history'; return; }
    const items = data.items;
    if (!items.length) { resEl.innerText = 'No saved estimates yet.'; return; }
    resEl.innerHTML = items.slice(0,12).map(it => {
      const sum = it.estimate.summary;
      return `<div class="history-item">
        <strong>${it.client_name || '—'}</strong> • ${new Date(it.created_at).toLocaleString()}
        <div>${formatUSD(sum.total)} — area ${it.estimate.inputs.area_sqft} sqft</div>
      </div>`;
    }).join('');
  } catch (e) {
    resEl.innerText = 'Error loading history';
  }
}

function renderResult(res) {
  const el = document.getElementById('resultsInner');
  if (!res || !res.estimate) { el.innerHTML = '<div class="placeholder">No estimate returned.</div>'; return; }
  const est = res.estimate;
  const inp = est.inputs;
  const li = est.line_items;
  const s = est.summary;
  const params = est.params;

  el.innerHTML = `
    <div><strong>Area:</strong> ${inp.area_sqft} sqft &nbsp; • &nbsp; <strong>Volume:</strong> ${inp.volume_cy} yd³</div>
    <table>
      <tr><th>Line item</th><th style="text-align:right">Amount</th></tr>
      <tr><td>Concrete (${params.price_per_cy}/yd³)</td><td style="text-align:right">${formatUSD(li.concrete_cost)}</td></tr>
      <tr><td>Rebar</td><td style="text-align:right">${formatUSD(li.rebar_cost)}</td></tr>
      <tr><td>Forms</td><td style="text-align:right">${formatUSD(li.forms_cost)}</td></tr>
      <tr><td>Labor (${est.line_items.labor_hours} hrs)</td><td style="text-align:right">${formatUSD(li.labor_cost)}</td></tr>
      ${li.tearout_cost ? `<tr><td>Tearout</td><td style="text-align:right">${formatUSD(li.tearout_cost)}</td></tr>` : ''}
      <tr><td><strong>Subtotal</strong></td><td style="text-align:right"><strong>${formatUSD(s.subtotal)}</strong></td></tr>
      <tr><td>Overhead</td><td style="text-align:right">${formatUSD(s.overhead)}</td></tr>
      <tr><td>Profit</td><td style="text-align:right">${formatUSD(s.profit)}</td></tr>
      <tr><td><strong>Total suggested bid</strong></td><td style="text-align:right"><strong>${formatUSD(s.total)}</strong></td></tr>
    </table>
    ${res.proposal ? `<div style="margin-top:12px"><h3>AI Proposal</h3><div style="white-space:pre-wrap;background:#fafafa;padding:10px;border-radius:8px;">${res.proposal}</div></div>` : ''}
    <div style="margin-top:10px">
      <button id="copyBtn">Copy Proposal</button>
      <button id="downloadCsv">Download CSV</button>
    </div>
  `;

  document.getElementById('copyBtn').onclick = () => {
    const text = res.proposal || `Estimate total: ${formatUSD(s.total)}`;
    navigator.clipboard.writeText(text);
    alert('Copied to clipboard');
  };
  document.getElementById('downloadCsv').onclick = () => {
    const csv = [
      ['Item','Amount'],
      ['Concrete', li.concrete_cost],
      ['Rebar', li.rebar_cost],
      ['Forms', li.forms_cost],
      ['Labor', li.labor_cost],
      ['Tearout', li.tearout_cost || 0],
      ['Subtotal', s.subtotal],
      ['Overhead', s.overhead],
      ['Profit', s.profit],
      ['Total', s.total]
    ].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'estimate.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadHistory();

  const form = document.getElementById('estimateForm');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const payload = {};
    for (const [k,v] of fd.entries()) {
      // handle checkboxes separately
      payload[k] = v;
    }
    // checkboxes: tearout, generate_proposal
    payload.tearout = form.querySelector('input[name="tearout"]').checked;
    payload.generate_proposal = form.querySelector('input[name="generate_proposal"]').checked;

    // numeric parsing
    ['width_ft','length_ft','thickness_in','price_per_cy','rebar_cost_per_sqft'].forEach(k => {
      if (payload[k] !== undefined) payload[k] = Number(payload[k]);
    });

    const res = await fetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) {
      alert('Error calculating estimate');
      return;
    }
    renderResult(data);
    await loadHistory();
  });

  $('#refreshRates').then(btn => {
    btn.onclick = () => {
      // restore defaults client-side (simple)
      form.price_per_cy.value = 140;
      form.rebar_cost_per_sqft.value = 1.25;
      alert('Defaults loaded — adjust to your local prices.');
    };
  });
});
