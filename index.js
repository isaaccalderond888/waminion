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
    const chats = await client.getChats();
    const now = Math.floor(Date.now() / 1000);
    const pending = [];

    for (const chat of chats) {
      if (chat.isGroup) continue;
      if (!chat.lastMessage) continue;

      const last = chat.lastMessage;
      if (last.fromMe) continue;

      const messages = await chat.fetchMessages({ limit: 5 });
      const recentMessages = messages
        .filter(m => m.body && m.body.trim())
        .slice(-3)
        .map(m => ({
          fromMe: m.fromMe,
          body: m.body,
          timestamp: m.timestamp,
        }));

      const contact = await chat.getContact();
      const name = contact.pushname || contact.name || chat.name || chat.id.user;
      const daysPending = Math.floor((now - last.timestamp) / 86400);

      pending.push({
        name,
        lastMessage: last.body || '[media o sticker]',
        lastMessageTime: last.timestamp,
        daysPending,
        recentMessages,
      });
    }

    if (pending.length === 0) {
      console.log(chalk.green('\n¡No tienes chats pendientes de respuesta! 🎉\n'));
      process.exit(0);
    }

    console.log(chalk.gray(`Encontrados ${pending.length} chats pendientes. Clasificando con IA...\n`));

    const classified = await classifyChats(pending);

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
