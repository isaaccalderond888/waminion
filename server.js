require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const chalk = require('chalk');
const { classifyChats } = require('./classifier');
const { saveReport } = require('./reporter');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(chalk.red('Error: ANTHROPIC_API_KEY no definida en .env'));
  process.exit(1);
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static(__dirname + '/public'));

let waClient = null;
let status = 'disconnected'; // disconnected | qr | ready | scanning | done

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
    io.emit('status', { type: 'error', message: 'WhatsApp desconectado' });
  });

  waClient.initialize();
}

io.on('connection', (socket) => {
  socket.emit('status', { type: status, message: statusMessage(status) });

  socket.on('start_triage', async () => {
    if (status !== 'ready') return;
    status = 'scanning';
    io.emit('status', { type: 'scanning', message: 'Cargando chats...' });

    try {
      const chats = await waClient.getChats();
      const now = Math.floor(Date.now() / 1000);
      const sieteAias = now - 7 * 24 * 60 * 60;
      const candidates = [];
      let procesados = 0;

      for (const chat of chats) {
        if (chat.isGroup) continue;
        if (!chat.lastMessage) continue;
        if (chat.lastMessage.timestamp < sieteAias) continue;

        try {
          const messages = await chat.fetchMessages({ limit: 10 });
          const recentMessages = messages
            .filter(m => (m.body && m.body.trim()) || m.type !== 'chat')
            .slice(-8)
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

        procesados++;
        if (procesados % 10 === 0) {
          io.emit('status', { type: 'scanning', message: `Revisando chats... ${procesados}/${chats.length}` });
        }
      }

      io.emit('status', { type: 'scanning', message: `Analizando ${candidates.length} chats con IA...` });
      const classified = await classifyChats(candidates);

      saveReport(classified);
      status = 'ready';
      io.emit('report', classified);
      io.emit('status', { type: 'ready', message: `Listo — ${classified.length} pendientes encontrados` });
    } catch (err) {
      status = 'ready';
      io.emit('status', { type: 'error', message: 'Error: ' + err.message });
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
