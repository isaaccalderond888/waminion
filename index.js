require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const chalk = require('chalk');
const { classifyChats } = require('./classifier');
const { printReport, saveReport } = require('./reporter');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(chalk.red('Error: ANTHROPIC_API_KEY no definida en .env'));
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 120000,
  },
});

client.on('qr', (qr) => {
  console.log(chalk.cyan('\n📱 Escanea este QR con WhatsApp Business:\n'));
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log(chalk.green('\n✔ Sesión autenticada'));
});

client.on('auth_failure', (msg) => {
  console.error(chalk.red('✘ Fallo de autenticación:'), msg);
  process.exit(1);
});

client.on('ready', async () => {
  console.log(chalk.green('✔ WhatsApp conectado\n'));
  console.log(chalk.gray('Escaneando chats pendientes...'));

  try {
    console.log(chalk.gray('Cargando lista de chats (puede tardar 1-2 minutos)...'));
    const chats = await client.getChats();
    console.log(chalk.gray(`Total de chats encontrados: ${chats.length}`));

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
          .filter(m => m.body && m.body.trim() || m.type !== 'chat')
          .slice(-8)
          .map(m => ({
            fromMe: m.fromMe,
            body: m.body && m.body.trim()
              ? m.body
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

        candidates.push({
          name,
          lastMessageTime: chat.lastMessage.timestamp,
          recentMessages,
        });
      } catch (e) {
        // skip chats that fail individually
      }

      procesados++;
      if (procesados % 20 === 0) {
        process.stdout.write(chalk.gray(`  Revisados ${procesados}/${chats.length}...\r`));
      }
    }

    if (candidates.length === 0) {
      console.log(chalk.green('\n¡No tienes chats con actividad esta semana! 🎉\n'));
      process.exit(0);
    }

    console.log(chalk.gray(`\nAnalizando ${candidates.length} chats con IA (detectando pendientes y clasificando)...\n`));

    const classified = await classifyChats(candidates);

    printReport(classified);
    saveReport(classified);
  } catch (err) {
    console.error(chalk.red('Error durante el triaje:'), err.message);
  } finally {
    await client.destroy();
    process.exit(0);
  }
});

client.initialize();
