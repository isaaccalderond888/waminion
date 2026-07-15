// triage.js — one-shot: conecta, escanea, clasifica, guarda reporte.json y se cierra.
// Sin servidor colgado. Se ejecuta con: node triage.js
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const chalk = require('chalk');
const { classifyChats } = require('./classifier');
const { printReport, saveReport } = require('./reporter');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(chalk.red('Falta ANTHROPIC_API_KEY en .env'));
  process.exit(1);
}

const DIAS = Number(process.env.DIAS || 7); // ventana de días a revisar

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 180000,
  },
});

client.on('qr', (qr) => {
  console.log(chalk.cyan('\n📱 Escanea este QR con WhatsApp Business:\n'));
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log(chalk.gray('Sesión autenticada, conectando...')));
client.on('auth_failure', (m) => { console.error(chalk.red('Fallo de auth:'), m); process.exit(1); });

client.on('ready', async () => {
  console.log(chalk.green('\n✔ WhatsApp conectado\n'));
  try {
    console.log(chalk.gray('Leyendo lista de chats...'));

    let allChats;
    try {
      allChats = await client.getChats();
    } catch (e) {
      console.log(chalk.yellow('Reintentando...'));
      await wait(3000);
      allChats = await client.getChats();
    }

    const now = Math.floor(Date.now() / 1000);
    const desde = now - DIAS * 24 * 60 * 60;
    const recientes = allChats.filter(c =>
      !c.isGroup && c.lastMessage && c.lastMessage.timestamp >= desde
    );

    console.log(chalk.gray(`${recientes.length} chats con actividad en los últimos ${DIAS} días.\n`));

    const candidates = [];
    for (let i = 0; i < recientes.length; i++) {
      const chat = recientes[i];
      try {
        const messages = await chat.fetchMessages({ limit: 8 });
        const recentMessages = messages
          .filter(m => (m.body && m.body.trim()) || m.type !== 'chat')
          .slice(-6)
          .map(m => ({
            fromMe: m.fromMe,
            body: mediaLabel(m),
            timestamp: m.timestamp,
            type: m.type,
          }));
        const contact = await chat.getContact();
        const name = contact.pushname || contact.name || chat.name || chat.id.user;
        candidates.push({ name, lastMessageTime: chat.lastMessage.timestamp, recentMessages });
      } catch (e) { /* saltar chat problemático */ }

      process.stdout.write(chalk.gray(`  Leyendo ${i + 1}/${recientes.length}...\r`));
      if ((i + 1) % 5 === 0) await wait(250);
    }

    console.log(chalk.gray(`\n\nClasificando con IA...\n`));
    const classified = await classifyChats(candidates);

    printReport(classified);
    saveReport(classified);
    console.log(chalk.cyan('\n📄 Reporte guardado en reporte.json — pégalo en Claude para el triaje.\n'));
  } catch (err) {
    console.error(chalk.red('\nError:'), err.message || err);
  } finally {
    try { await client.destroy(); } catch (e) {}
    process.exit(0);
  }
});

function mediaLabel(m) {
  if (m.body && m.body.trim()) return m.body;
  return m.type === 'ptt' ? '[mensaje de voz]'
    : m.type === 'image' ? '[imagen]'
    : m.type === 'video' ? '[video]'
    : m.type === 'document' ? '[documento]'
    : m.type === 'sticker' ? '[sticker]'
    : `[${m.type}]`;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

client.initialize();
