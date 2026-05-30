const chalk = require('chalk');
const fs = require('fs');
const { CATEGORIES } = require('./classifier');

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function dayLabel(days) {
  if (days === 0) return chalk.yellow('hoy');
  if (days === 1) return chalk.yellow('1 día');
  return days <= 3 ? chalk.yellow(`${days} días`) : chalk.red(`${days} días`);
}

function printReport(classifiedChats) {
  console.log('\n' + chalk.bold.white('═'.repeat(60)));
  console.log(chalk.bold.cyan('  📋  REPORTE DE TRIAJE WHATSAPP'));
  console.log(chalk.bold.white('═'.repeat(60)) + '\n');

  const byPriority = [1, 2, 3, 4];

  for (const priority of byPriority) {
    const group = classifiedChats.filter(c => c.prioridad === priority);
    if (group.length === 0) continue;

    const catKey = Object.keys(CATEGORIES).find(k => CATEGORIES[k].priority === priority);
    const cat = CATEGORIES[catKey];

    console.log(chalk.bold(`\n${cat.emoji} ${cat.label} (${group.length})`));
    console.log(chalk.gray('─'.repeat(50)));

    for (const chat of group) {
      const daysStr = dayLabel(chat.daysPending);
      console.log(`\n  ${chalk.bold(chat.name)} ${chalk.gray('·')} sin respuesta: ${daysStr}`);
      console.log(`  ${chalk.gray('Fecha:')} ${formatDate(chat.lastMessageTime)}`);
      console.log(`  ${chalk.white('Último:')} "${chalk.italic(chat.lastMessage.slice(0, 100))}"`);
      if (chat.razon) console.log(`  ${chalk.gray('IA:')} ${chat.razon}`);

      if (chat.recentMessages.length > 0) {
        console.log(`  ${chalk.gray('Contexto:')}`);
        for (const msg of chat.recentMessages) {
          const who = msg.fromMe ? chalk.blue('  [Tú]') : chalk.green(`  [${chat.name.split(' ')[0]}]`);
          console.log(`${who} ${msg.body.slice(0, 80)}`);
        }
      }
    }
    console.log('');
  }

  const counts = {
    URGENTE: classifiedChats.filter(c => c.categoria === 'URGENTE').length,
    GESTION: classifiedChats.filter(c => c.categoria === 'GESTION').length,
    INFO: classifiedChats.filter(c => c.categoria === 'INFO').length,
    SOCIAL: classifiedChats.filter(c => c.categoria === 'SOCIAL').length,
  };

  console.log(chalk.bold.white('═'.repeat(60)));
  console.log(chalk.bold('  RESUMEN'));
  console.log(chalk.bold.white('─'.repeat(60)));
  console.log(`  Total pendientes: ${chalk.bold(classifiedChats.length)}`);
  console.log(`  🔴 Urgentes: ${chalk.bold.red(counts.URGENTE)}`);
  console.log(`  🟡 Gestión:  ${chalk.bold.yellow(counts.GESTION)}`);
  console.log(`  🟢 Info:     ${chalk.bold.green(counts.INFO)}`);
  console.log(`  ⚪ Social:   ${chalk.bold.gray(counts.SOCIAL)}`);
  console.log(chalk.bold.white('═'.repeat(60)) + '\n');
}

function saveReport(classifiedChats) {
  const report = {
    generadoEn: new Date().toISOString(),
    totalPendientes: classifiedChats.length,
    resumen: {
      urgentes: classifiedChats.filter(c => c.categoria === 'URGENTE').length,
      gestion: classifiedChats.filter(c => c.categoria === 'GESTION').length,
      info: classifiedChats.filter(c => c.categoria === 'INFO').length,
      social: classifiedChats.filter(c => c.categoria === 'SOCIAL').length,
    },
    chats: classifiedChats.map(c => ({
      nombre: c.name,
      categoria: c.categoria,
      emoji: c.emoji,
      razonIA: c.razon,
      diasSinRespuesta: c.daysPending,
      ultimoMensaje: c.lastMessage,
      fechaUltimoMensaje: formatDate(c.lastMessageTime),
      contexto: c.recentMessages.map(m => ({
        de: m.fromMe ? 'yo' : c.name,
        mensaje: m.body,
        fecha: formatDate(m.timestamp),
      })),
    })),
  };

  fs.writeFileSync('reporte.json', JSON.stringify(report, null, 2), 'utf8');
  console.log(chalk.green('  ✔ Reporte guardado en reporte.json\n'));
}

module.exports = { printReport, saveReport };
