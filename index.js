import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, REST, Routes, ActivityType } from 'discord.js';
import { Rcon } from 'rcon-client';

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  MC_NAME = 'Aurora SMP',
  STATUS_CHANNEL_ID,
  STATUS_UPDATE_SECONDS = '60',
  PRESENCE_UPDATE_SECONDS = '60',
  WEBSITE_URL,

  RCON_HOST,
  RCON_PORT = '8056',
  RCON_PASSWORD,
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID');
if (!GUILD_ID) throw new Error('Falta GUILD_ID');
if (!RCON_HOST) throw new Error('Falta RCON_HOST');
if (!RCON_PASSWORD) throw new Error('Falta RCON_PASSWORD');

// HTTP (health)
const app = express();
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

// Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  { name: 'online', description: 'Muestra cuántos jugadores hay online (real, por RCON).' },
  { name: 'rawlist', description: 'Muestra la respuesta cruda del comando list (debug).' },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registrados/actualizados (guild).');
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function parseListResponse(raw) {
  const res = stripAnsi(raw);

  // Tu formato (CraftBukkit/Paper suele sacar esto):
  // "Online Players 0/16: "
  let m = res.match(/Online Players\s+(\d+)\s*\/\s*(\d+)/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), raw: res };

  // Formato vanilla inglés:
  m = res.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), raw: res };

  // Último recurso: si hay algo tipo "X/Y" en el texto
  m = res.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return { online: Number(m[1]), max: Number(m[2]), raw: res };

  return { online: null, max: null, raw: res };
}

async function rconCommand(cmd) {
  const rcon = await Rcon.connect({
    host: RCON_HOST,
    port: Number(RCON_PORT),
    password: RCON_PASSWORD,
    timeout: 5000,
  });

  try {
    return await rcon.send(cmd);
  } finally {
    try { await rcon.end(); } catch {}
  }
}

let lastShown = null;

async function getOnlineCount() {
  const raw = await rconCommand('list');
  const parsed = parseListResponse(raw);

  // Log solo si cambia (para no spamear)
  const key = `${parsed.online}/${parsed.max}`;
  if (key !== lastShown) {
    console.log('[RCON RAW]', JSON.stringify(parsed.raw));
    console.log('[RCON PARSED]', parsed.online, parsed.max);
    lastShown = key;
  }

  return parsed;
}

async function updatePresence() {
  try {
    const { online, max } = await getOnlineCount();
    const text = (typeof online === 'number' && typeof max === 'number')
      ? `${online}/${max} online | ${MC_NAME}`
      : `Online: ? | ${MC_NAME}`;

    client.user?.setPresence({
      activities: [{ name: text, type: ActivityType.Watching }],
      status: 'online', // SIEMPRE verde
    });
  } catch (e) {
    console.log('[RCON FAIL]', e?.message || e);
    client.user?.setPresence({
      activities: [{ name: `Online: ? | ${MC_NAME}`, type: ActivityType.Watching }],
      status: 'online',
    });
  }
}

let panelMessageId = null;
async function upsertPanel() {
  if (!STATUS_CHANNEL_ID) return;
  const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  let text = `👥 Jugadores online: ?`;
  try {
    const { online, max } = await getOnlineCount();
    if (typeof online === 'number' && typeof max === 'number') text = `👥 Jugadores online: ${online}/${max}`;
  } catch {}

  const embed = {
    title: `📡 ${MC_NAME}`,
    description: text,
    fields: WEBSITE_URL ? [{ name: 'Web', value: WEBSITE_URL, inline: false }] : [],
    timestamp: new Date().toISOString(),
  };

  if (panelMessageId) {
    const msg = await channel.messages.fetch(panelMessageId).catch(() => null);
    if (msg) return msg.edit({ embeds: [embed] });
  }
  const created = await channel.send({ embeds: [embed] });
  panelMessageId = created.id;
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'online') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const { online, max } = await getOnlineCount();
      return interaction.editReply(
        (typeof online === 'number' && typeof max === 'number')
          ? `👥 Online real: ${online}/${max}`
          : `👥 Online real: ?`
      );
    } catch (e) {
      return interaction.editReply(`👥 Online real: ? (RCON falló)`);
    }
  }

  if (interaction.commandName === 'rawlist') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const raw = await rconCommand('list');
      const clean = stripAnsi(raw);
      const msg = clean.length > 1900 ? clean.slice(0, 1900) + '…' : clean;
      return interaction.editReply("```" + msg + "```");
    } catch (e) {
      return interaction.editReply(`No pude leer list por RCON: ${e?.message || e}`);
    }
  }
});

client.once('ready', async () => {
  console.log(`🤖 Bot listo como ${client.user.tag}`);
  console.log(`📌 RCON -> ${RCON_HOST}:${RCON_PORT}`);

  await registerCommands();

  const panelSec = Math.max(15, Number(STATUS_UPDATE_SECONDS || 60));
  const presSec = Math.max(15, Number(PRESENCE_UPDATE_SECONDS || 60));

  await upsertPanel();
  await updatePresence();

  if (STATUS_CHANNEL_ID) setInterval(() => upsertPanel().catch(console.error), panelSec * 1000);
  setInterval(() => updatePresence().catch(console.error), presSec * 1000);
});

client.login(DISCORD_TOKEN);
