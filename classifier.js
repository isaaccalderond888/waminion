const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = {
  URGENTE: { emoji: '🔴', label: 'URGENTE', priority: 1 },
  GESTION: { emoji: '🟡', label: 'GESTIÓN', priority: 2 },
  INFO: { emoji: '🟢', label: 'INFO', priority: 3 },
  SOCIAL: { emoji: '⚪', label: 'SOCIAL', priority: 4 },
};

async function classifyChats(pendingChats) {
  if (pendingChats.length === 0) return [];

  const chatSummaries = pendingChats.map((chat, i) => {
    const context = chat.recentMessages
      .map(m => `  [${m.fromMe ? 'YO' : chat.name}]: ${m.body}`)
      .join('\n');
    return `CHAT_${i} | Contacto: ${chat.name} | Días sin respuesta: ${chat.daysPending}\nÚltimo mensaje: "${chat.lastMessage}"\nContexto reciente:\n${context}`;
  }).join('\n\n---\n\n');

  const prompt = `Eres un asistente de triaje para una clínica médica. Clasifica cada chat de WhatsApp en una de estas categorías:

- URGENTE: solicitud de cita, seguimiento clínico, síntomas, emergencias médicas
- GESTION: coordinación, pagos, facturas, preguntas sobre servicios, agendamiento
- INFO: mensajes informativos que no requieren acción inmediata, confirmaciones recibidas
- SOCIAL: mensajes personales, conversaciones casuales, saludos sin acción requerida

Para cada chat, responde SOLO con una línea en formato JSON:
{"id": "CHAT_0", "categoria": "URGENTE", "razon": "breve explicación"}

Chats a clasificar:

${chatSummaries}

Responde ÚNICAMENTE con un array JSON válido, sin texto adicional.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].text.trim();
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Claude no devolvió JSON válido: ' + raw);

  const classifications = JSON.parse(jsonMatch[0]);

  return pendingChats.map((chat, i) => {
    const found = classifications.find(c => c.id === `CHAT_${i}`);
    const catKey = found?.categoria || 'SOCIAL';
    const cat = CATEGORIES[catKey] || CATEGORIES.SOCIAL;
    return {
      ...chat,
      categoria: catKey,
      emoji: cat.emoji,
      prioridad: cat.priority,
      razon: found?.razon || '',
    };
  }).sort((a, b) => a.prioridad - b.prioridad);
}

module.exports = { classifyChats, CATEGORIES };
