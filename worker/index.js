// coivalidator-api — the COI Validator analysis engine.
// Takes the text of a Certificate of Insurance (extracted client-side from a
// PDF/photo or pasted) + the compliance requirements the user cares about, and
// returns a structured, expert-grade compliance verdict via Fireworks AI.
//
// No vendor lock to TachyonTracker; this is the COI Validator's own backend.
// Secrets (wrangler secret put): FIREWORKS_API_KEY
// Vars (wrangler.toml):           FIREWORKS_MODEL, FIREWORKS_BASE_URL

const RL_WINDOW_MS = 60_000
const RL_MAX = 12 // analyses / minute / IP (best-effort, per-isolate)
const rl = new Map()

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  }
}
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(extra) },
  })
}
function rateOk(ip, now) {
  const e = rl.get(ip)
  if (!e || now > e.reset) { rl.set(ip, { n: 1, reset: now + RL_WINDOW_MS }); return true }
  if (e.n >= RL_MAX) return false
  e.n++; return true
}

const SYSTEM_PROMPT = `You are COI Validator, a meticulous commercial-insurance compliance analyst. You read Certificates of Insurance (ACORD 25 and similar) and judge whether they satisfy the holder's requirements.

Respond with VALID JSON ONLY — no markdown, no prose outside the JSON. Use this exact shape:
{
  "verdict": "compliant" | "issues" | "non_compliant" | "unreadable",
  "overall_score": 0-100,
  "headline": "one plain-English sentence a non-expert understands",
  "summary": "2-3 sentence professional assessment",
  "insured": { "name": string|null, "carriers": string|null, "certificate_holder": string|null },
  "policies": [
    { "type": "General Liability"|"Automobile Liability"|"Workers Compensation"|"Umbrella/Excess"|"Professional"|"Other",
      "policy_number": string|null,
      "effective": "YYYY-MM-DD"|null,
      "expiration": "YYYY-MM-DD"|null,
      "limits": string,
      "status": "ok"|"low"|"expired"|"expiring"|"missing" }
  ],
  "checks": [
    { "label": "human-readable requirement (e.g. 'General Liability ≥ $1M / $2M')",
      "pass": true|false,
      "found": "what the COI actually shows, or 'Not found'",
      "why": "plain-English explanation of why this passes or fails" }
  ],
  "top_risks": [ { "issue": string, "impact": "what could go wrong in plain English", "fix": "the exact action to request from the contractor/broker" } ],
  "recommended_email": "a short, polite email the user can send the contractor's broker requesting the fixes (or empty string if compliant)"
}

Rules:
- Be specific and quote real values from the document.
- If the text is clearly not a COI or is unreadable, set verdict "unreadable" and explain in headline.
- "expiring" = expires within 30 days of today; "expired" = already past.
- Default professional minimums when the user gives none: GL $1M occ / $2M agg, Auto $1M CSL, WC statutory + Employers Liability $500k, Additional Insured + Waiver of Subrogation + Primary & Non-Contributory endorsements.
- top_risks: at most 3, most dangerous first. Empty array if fully compliant.
- Keep every explanation jargon-free enough for a 9-year-old, yet precise enough for a risk manager.`

async function analyze(env, { text, image, requirements, today, lang }) {
  const langLine = lang === 'es' ? 'IMPORTANT: Write every text value in the JSON (headline, summary, why, issue, impact, fix, recommended_email, status, verdict explanations) in natural Latin-American Spanish.' : '';
  const base = env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1'
  const textModel = env.FIREWORKS_MODEL || 'accounts/fireworks/models/deepseek-v4-pro'
  const visionModel = env.FIREWORKS_VISION_MODEL || 'accounts/fireworks/models/kimi-k2p6'
  const reqLine = requirements && requirements.trim()
    ? `The certificate holder's requirements are:\n${requirements.trim()}`
    : `No explicit requirements were given — judge against standard professional contractor minimums.`

  let model, userContent
  if (image) {
    // Photo/scan of a COI — read it directly with a vision model.
    model = visionModel
    userContent = [
      { type: 'text', text: `Today's date is ${today}.\n\n${reqLine}\n\nThis is an image of a Certificate of Insurance. First read ALL text in the image, then analyze it and return the required JSON.${langLine}` },
      { type: 'image_url', image_url: { url: image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}` } },
    ]
  } else {
    model = textModel
    userContent = `Today's date is ${today}.\n\n${reqLine}\n\n--- CERTIFICATE OF INSURANCE TEXT ---\n${text.slice(0, 18000)}`
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.FIREWORKS_API_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`AI ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = await res.json()
  let content = data.choices?.[0]?.message?.content || ''
  // Some models wrap JSON in fences or prepend reasoning — extract the JSON object.
  if (content.startsWith('```')) content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  try { return JSON.parse(content) }
  catch {
    const m = content.match(/\{[\s\S]*\}/)
    if (m) return JSON.parse(m[0])
    throw new Error('Model returned non-JSON')
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() })
    if (url.pathname === '/api/health') return json({ ok: true, service: 'coivalidator-api' })
    if (url.pathname !== '/api/analyze' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404)
    }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown'
    const now = Date.now()
    if (!rateOk(ip, now)) return json({ error: 'Too many requests. Please wait a minute and try again.' }, 429)

    let body
    try { body = await request.json() } catch { return json({ error: 'Invalid JSON body.' }, 400) }
    const text = (body.text || '').toString()
    const image = (body.image || '').toString()
    const requirements = (body.requirements || '').toString()
    const lang = (body.lang || 'en').toString()
    const today = (body.today || '').toString().match(/^\d{4}-\d{2}-\d{2}$/) ? body.today : new Date().toISOString().slice(0, 10)

    if (!image && text.trim().length < 40) {
      return json({ error: "We couldn't read enough text from that document. Try a clearer photo, a PDF, or paste the text." }, 400)
    }
    if (image && image.length > 12_000_000) {
      return json({ error: 'Image too large. Please use an image under ~8MB.' }, 413)
    }
    if (!env.FIREWORKS_API_KEY) return json({ error: 'Service not configured.' }, 503)

    try {
      const result = await analyze(env, { text, image, requirements, today, lang })
      return json(result, 200)
    } catch (e) {
      return json({ error: 'Analysis failed. Please try again in a moment.', detail: String(e).slice(0, 180) }, 502)
    }
  },
}
