const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = {
  URGENTE: { emoji: '🔴', label: 'URGENTE', priority: 1 },
  GESTION: { emoji: '🟡', label: 'GESTIÓN', priority: 2 },
  INFO: { emoji: '🟢', label: 'INFO', priority: 3 },
  SOCIAL: { emoji: '⚪', label: 'SOCIAL', priority: 4 },
};

const BATCH_SIZE = 30;

async function classifyChats(candidates) {
  if (candidates.length === 0) return [];

  // process in batches to avoid token limits
  if (candidates.length > BATCH_SIZE) {
    const results = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const batchResult = await classifyBatch(batch, i);
      results.push(...batchResult);
    }
    return results.sort((a, b) => a.prioridad - b.prioridad);
  }

  return classifyBatch(candidates, 0);
}

async function classifyBatch(candidates, offset) {
  const chatSummaries = candidates.map((chat, i) => {
    const context = chat.recentMessages
      .map(m => `    [${m.fromMe ? 'YO' : chat.name}]: ${m.body}`)
      .join('\n');
    return `CHAT_${offset + i} | Contacto: ${chat.name}\nMensajes recientes (del más antiguo al más nuevo):\n${context}`;
  }).join('\n\n---\n\n');

  const prompt = `Eres un asistente personal analizando conversaciones de WhatsApp de los últimos 7 días. El usuario tiene TDAH y a veces inicia tareas pero no las completa, o responde pero olvida hacer el seguimiento real.

Tu trabajo es:
1. Determinar si cada conversación tiene algo PENDIENTE de acción por parte del usuario ("YO")
2. Si está pendiente, clasificarlo y describir exactamente qué falta hacer

Una conversación está PENDIENTE si:
- Alguien le pidió algo al usuario y no hay confirmación de que se hizo
- Quedaron de coordinar algo y no quedó cerrado
- Hay un mensaje de voz sin respuesta
- El usuario respondió pero no completó la tarea implícita
- La conversación quedó "en el aire" sin cierre claro

Una conversación está RESUELTA si:
- Hay una confirmación clara de ambas partes
- El último intercambio es un agradecimiento o confirmación final
- Claramente no requiere acción

Categorías para los PENDIENTES:
- URGENTE: citas médicas, seguimiento clínico, salud, emergencias
- GESTION: coordinación, pagos, agendamiento, tareas de trabajo
- INFO: requiere una respuesta simple o acuse de recibo
- SOCIAL: mensajes personales o conversacionales sin urgencia

Para cada chat responde en formato JSON:
{"id": "CHAT_0", "pendiente": true/false, "categoria": "GESTION", "resumen": "qué falta hacer exactamente", "razon": "por qué está pendiente"}

Si no está pendiente: {"id": "CHAT_0", "pendiente": false}

Chats a analizar:

${chatSummaries}

Responde ÚNICAMENTE con un array JSON válido, sin texto adicional.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].text.trim();
  // strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Claude no devolvió JSON válido: ' + raw);

  let classifications;
  try {
    classifications = JSON.parse(jsonMatch[0]);
  } catch (e) {
    // try to recover truncated JSON by closing open structures
    const partial = jsonMatch[0].replace(/,\s*\{[^}]*$/, '') + ']';
    classifications = JSON.parse(partial);
  }

  const now = Math.floor(Date.now() / 1000);
  const pending = [];

  candidates.forEach((chat, i) => {
    const found = classifications.find(c => c.id === `CHAT_${offset + i}`);
    if (!found || !found.pendiente) return;

    const catKey = found.categoria || 'SOCIAL';
    const cat = CATEGORIES[catKey] || CATEGORIES.SOCIAL;
    const daysPending = Math.floor((now - chat.lastMessageTime) / 86400);

    pending.push({
      ...chat,
      lastMessage: found.resumen || chat.recentMessages.slice(-1)[0]?.body || '',
      daysPending,
      categoria: catKey,
      emoji: cat.emoji,
      prioridad: cat.priority,
      razon: found.razon || '',
    });
  });

  return pending.sort((a, b) => a.prioridad - b.prioridad);
}

module.exports = { classifyChats, CATEGORIES };
