const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = {
  URGENTE: { emoji: '🔴', label: 'URGENTE', priority: 1 },
  GESTION: { emoji: '🟡', label: 'GESTIÓN', priority: 2 },
  INFO: { emoji: '🟢', label: 'INFO', priority: 3 },
  SOCIAL: { emoji: '⚪', label: 'SOCIAL', priority: 4 },
};

const BATCH_SIZE = 10;

async function classifyChats(candidates) {
  if (candidates.length === 0) return [];

  const allPending = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchPending = await classifyBatch(batch);
    allPending.push(...batchPending);
  }
  return allPending.sort((a, b) => a.prioridad - b.prioridad);
}

async function classifyBatch(candidates) {
  const chatSummaries = candidates.map((chat, i) => {
    // limit to last 3 messages and truncate each to 120 chars to keep prompt small
    const context = chat.recentMessages.slice(-3)
      .map(m => `  [${m.fromMe ? 'YO' : chat.name.split(' ')[0]}]: ${m.body.slice(0, 120)}`)
      .join('\n');
    return `C${i} | ${chat.name}\n${context}`;
  }).join('\n\n');

  const prompt = `Analiza estas conversaciones de WhatsApp. El usuario tiene TDAH y olvida hacer seguimiento.

Determina si cada conversación tiene algo PENDIENTE de acción del usuario (YO).

PENDIENTE: alguien pidió algo sin confirmación, tarea prometida sin completar, mensaje de voz sin respuesta, conversación sin cierre.
RESUELTO: confirmación clara, agradecimiento final, no requiere acción.

Categorías: URGENTE (salud/citas médicas), GESTION (trabajo/pagos/agenda), INFO (respuesta simple), SOCIAL (personal)

Responde SOLO con JSON array, sin markdown, sin explicación:
[{"i":0,"p":true,"cat":"GESTION","q":"qué falta hacer"},{"i":1,"p":false}]

Conversaciones:
${chatSummaries}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].text;
  // extract JSON array regardless of markdown wrapping
  const match = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) {
    console.error('Sin JSON en respuesta:', raw.slice(0, 200));
    return [];
  }

  let classifications;
  try {
    classifications = JSON.parse(match[0]);
  } catch (e) {
    try {
      const fixed = match[0].replace(/,\s*\{[^}]*$/, '') + ']';
      classifications = JSON.parse(fixed);
    } catch (e2) {
      console.error('No se pudo parsear JSON:', match[0].slice(0, 200));
      return [];
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const pending = [];

  candidates.forEach((chat, i) => {
    const found = classifications.find(c => c.i === i);
    if (!found || !found.p) return;

    const catKey = (found.cat || 'SOCIAL').toUpperCase();
    const cat = CATEGORIES[catKey] || CATEGORIES.SOCIAL;
    const daysPending = Math.floor((now - chat.lastMessageTime) / 86400);

    pending.push({
      ...chat,
      lastMessage: found.q || chat.recentMessages.slice(-1)[0]?.body || '',
      daysPending,
      categoria: catKey,
      emoji: cat.emoji,
      prioridad: cat.priority,
      razon: found.q || '',
    });
  });

  return pending;
}

module.exports = { classifyChats, CATEGORIES };
