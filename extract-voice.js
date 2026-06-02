require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 120000,
  },
});

client.on('qr', (qr) => {
  console.log('Escanea el QR:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('Conectado. Extrayendo tus mensajes...');

  const chats = await client.getChats();
  const now = Math.floor(Date.now() / 1000);
  const treintaDias = now - 30 * 24 * 60 * 60;
  const myMessages = [];

  let count = 0;
  for (const chat of chats) {
    if (chat.isGroup) continue;
    if (!chat.lastMessage || chat.lastMessage.timestamp < treintaDias) continue;

    try {
      const messages = await chat.fetchMessages({ limit: 20 });
      for (const m of messages) {
        if (
          m.fromMe &&
          m.body &&
          m.body.trim().length > 5 &&
          m.type === 'chat'
        ) {
          myMessages.push(m.body.trim());
        }
      }
      count++;
      if (count % 5 === 0) process.stdout.write(`  ${count} chats procesados...\r`);
      await new Promise(r => setTimeout(r, 200));
    } catch (e) { /* skip */ }
  }

  const output = myMessages.join('\n---\n');
  fs.writeFileSync('mis-mensajes.txt', output, 'utf8');
  console.log(`\nListo. ${myMessages.length} mensajes guardados en mis-mensajes.txt`);
  await client.destroy();
  process.exit(0);
});

client.initialize();
