require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const Anthropic = require('@anthropic-ai/sdk');
const chalk = require('chalk');
const { classifyChats } = require('./classifier');
const { saveReport } = require('./reporter');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(chalk.red('Error: ANTHROPIC_API_KEY no definida en .env'));
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static(__dirname + '/public'));

let waClient = null;
let status = 'disconnected';
let lastReport = null;

const voiceProfile = `Estilo de escritura de Isaac:
1. Muy directo y corto — mensajes de 1-2 líneas, va al punto sin rodeos
2. Tono cálido pero informal — usa "hola", "lindo día 🙂", "qué gusto", nunca suena corporativo
3. Emojis escasos y específicos — 🙂 😊 😬, nunca más de uno por mensaje
4. "jeje" como muletilla para suavizar situaciones incómodas o cuando algo le da gracia
5. Minúsculas frecuentes — "perfecto", "vale", "gracias" sin mayúscula, es intencional
6. Frases puente características: "al ratito", "ahorita", "por ahí", "en cuanto", "sale vale", "va perfecto"
7. Cuando coordina horarios: da opciones concretas en lista. Ej: "martes 3pm / miércoles 3pm / jueves 11am"
8. Cuando algo es delicado escribe más largo pero siempre cierra con algo cálido
9. Nunca signos de exclamación solos — si usa "!" es con palabra: "Hola Mili!!", "Claro que sí!"
10. "Claro que sí" es su forma cálida de decir que sí, no solo "ok" o "sí"`;

function createClient() {
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      protocolTimeout: 120000,
    },
  });

  waClient.on('qr', (qr) => {
    status = 'qr';
    io.emit('qr', qr);
    io.emit('status', { type: 'qr', message: 'Escanea el QR con WhatsApp Business' });
  });

  waClient.on('authenticated', () => {
    io.emit('status', { type: 'info', message: 'Autenticado, conectando...' });
  });

  waClient.on('ready', () => {
    status = 'ready';
    io.emit('status', { type: 'ready', message: 'WhatsApp conectado ✔' });
  });

  waClient.on('disconnected', () => {
    status = 'disconnected';
    io.emit('status', { type: 'error', message: 'WhatsApp desconectado — reiniciando...' });
    setTimeout(() => {
      console.log(chalk.yellow('Reconectando WhatsApp...'));
      createClient();
    }, 5000);
  });

  waClient.initialize();
}

io.on('connection', (socket) => {
  socket.emit('status', { type: status, message: statusMessage(status) });
  if (lastReport) socket.emit('report', lastReport);

  socket.on('start_triage', async () => {
    if (status !== 'ready') return;
    status = 'scanning';
    io.emit('status', { type: 'scanning', message: 'Cargando chats...' });

    try {
      const allChats = await waClient.getChats();
      const now = Math.floor(Date.now() / 1000);
      const sieteAias = now - 7 * 24 * 60 * 60;

      // filter first without touching puppeteer
      const recentChats = allChats.filter(c =>
        !c.isGroup &&
        c.lastMessage &&
        c.lastMessage.timestamp >= sieteAias
      );

      io.emit('status', { type: 'scanning', message: `Leyendo ${recentChats.length} chats recientes...` });

      const candidates = [];
      for (let i = 0; i < recentChats.length; i++) {
        const chat = recentChats[i];
        try {
          const messages = await chat.fetchMessages({ limit: 8 });
          const recentMessages = messages
            .filter(m => (m.body && m.body.trim()) || m.type !== 'chat')
            .slice(-6)
            .map(m => ({
              fromMe: m.fromMe,
              body: m.body && m.body.trim() ? m.body
                : m.type === 'ptt' ? '[mensaje de voz]'
                : m.type === 'image' ? '[imagen]'
                : m.type === 'video' ? '[video]'
                : m.type === 'document' ? '[documento]'
                : m.type === 'sticker' ? '[sticker]'
                : `[${m.type}]`,
              timestamp: m.timestamp,
              type: m.type,
            }));

          const contact = await chat.getContact();
          const name = contact.pushname || contact.name || chat.name || chat.id.user;
          candidates.push({ name, lastMessageTime: chat.lastMessage.timestamp, recentMessages });
        } catch (e) { /* skip */ }

        if ((i + 1) % 5 === 0) {
          io.emit('status', { type: 'scanning', message: `Leyendo chats... ${i + 1}/${recentChats.length}` });
          await new Promise(r => setTimeout(r, 300)); // small pause to avoid overloading puppeteer
        }
      }

      io.emit('status', { type: 'scanning', message: `Clasificando ${candidates.length} chats con IA...` });
      const classified = await classifyChats(candidates);

      saveReport(classified);
      lastReport = classified;
      status = 'ready';
      io.emit('report', classified);
      if (voiceProfile) io.emit('voice_profile', voiceProfile);
      io.emit('status', { type: 'ready', message: `Listo — ${classified.length} pendientes encontrados` });
    } catch (err) {
      status = 'ready';
      io.emit('status', { type: 'error', message: 'Error: ' + err.message });
    }
  });

  socket.on('get_suggestion', async ({ idx }) => {
    if (!lastReport || !lastReport[idx]) return;
    const chat = lastReport[idx];
    try {
      const context = (chat.recentMessages || []).slice(-5)
        .map(m => `[${m.fromMe ? 'YO' : chat.name}]: ${m.body}`).join('\n');
      const res = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content:
          `Eres Isaac (psicólogo) respondiendo un WhatsApp. Debes sonar exactamente como él, no como un asistente.

${voiceProfile ? `ESTILO DE ESCRITURA DE ISAAC (síguelo al pie de la letra):\n${voiceProfile}\n` : ''}
Links para agendar (úsalos solo si el tema es terapia o disponibilidad):
- Sesiones online/Zoom: https://calendly.com/isaac-calderon-d
- Sesiones presenciales (Clínica Newman): https://clinicanewman.site.agendapro.com/mx/sucursal/425003/profesional/692142

Si es sobre agendar, sugiere primero Calendly y menciona que si no encuentra espacio que te avise para ver entre las presenciales.

Conversación:
${context}

Qué falta resolver: ${chat.lastMessage}

Escribe SOLO el mensaje de WhatsApp, nada más.`
        }],
      });
      socket.emit('suggestion', { idx, text: res.content[0].text.trim() });
    } catch (e) {
      socket.emit('suggestion', { idx, text: 'Error: ' + e.message });
    }
  });
});


function statusMessage(s) {
  if (s === 'disconnected') return 'Iniciando...';
  if (s === 'qr') return 'Escanea el QR con WhatsApp Business';
  if (s === 'ready') return 'WhatsApp conectado ✔';
  if (s === 'scanning') return 'Escaneando...';
  return '';
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(chalk.cyan(`\n🌐 Abre tu navegador en: http://localhost:${PORT}\n`));
  createClient();
});
