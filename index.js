import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, REST, Routes, ActivityType, EmbedBuilder } from 'discord.js';
import { Rcon } from 'rcon-client';

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,

  MC_NAME = 'Aurora SMP',
  WEBSITE_URL,

  STATUS_CHANNEL_ID,
  STATUS_UPDATE_SECONDS = '60',
  PRESENCE_UPDATE_SECONDS = '60',

  RCON_HOST,
  RCON_PORT = '8056',
  RCON_PASSWORD,
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID');
if (!GUILD_ID) throw new Error('Falta GUILD_ID');
if (!RCON_HOST) throw new Error('Falta RCON_HOST');
if (!RCON_PASSWORD) throw new Error('Falta RCON_PASSWORD');

// ---------------- HTTP health ----------------
const app = express();
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

// ---------------- Discord ----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  { name: 'online', description: 'Muestra cuántos jugadores hay online (RCON real).' },
  { name: 'rawlist', description: 'Devuelve el texto crudo del comando list (debug).' },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registrados/actualizados (guild).');
}

// ----------- Helpers: limpiar colores y basura -----------
function cleanMinecraftText(s) {
  // Quita códigos de color Minecraft (§a, §7, etc) y ANSI por si acaso
  return String(s)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/§[0-9A-FK-OR]/gi, '');
}

function parseOnlineMaxFromList(raw) {
  const res = cleanMinecraftText(raw).replace(/\r/g, '');

  // TU formato exacto:
  // "Online Players 0/16: "
  let m = res.match(/Online Players\s*(\d+)\s*\/\s*(\d+)\s*:/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  // Formato vanilla:
  m = res.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  // Último recurso: primer X/Y que aparezca
  m = res.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  return { online: null, max: null, cleaned: res };
}

// ----------- RCON -----------
async function rconSend(cmd) {
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

let panelMessageId = null;
let lastKey = '';

async function getCounts() {
  const raw = await rconSend('list');
  const parsed = parseOnlineMaxFromList(raw);

  const key = `${parsed.online}/${parsed.max}`;
  if (key !== lastKey) {
    console.log('[RCON RAW CLEANED]', JSON.stringify(parsed.cleaned));
    console.log('[RCON PARSED]', parsed.online, parsed.max);
    lastKey = key;
  }

  return parsed;
}

// ----------- Panel + Presence -----------
function buildEmbed(online, max) {
  const value = (typeof online === 'number' && typeof max === 'number') ? `${online}/${max}` : '?';

  const embed = new EmbedBuilder()
    .setTitle(`📡 ${MC_NAME}`)
    .setDescription(`👥 **Jugadores online:** \`${value}\``)
    .setTimestamp(new Date());

  if (WEBSITE_URL) embed.addFields({ name: 'Web', value: WEBSITE_URL, inline: false });
  return embed;
}

async function upsertPanel() {
  if (!STATUS_CHANNEL_ID) return;

  const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  let online = null, max = null;

  try {
    const data = await getCounts();
    online = data.online;
    max = data.max;
  } catch (e) {
    console.log('[RCON FAIL]', e?.message || e);
  }

  const embed = buildEmbed(online, max);

  if (panelMessageId) {
    const msg = await channel.messages.fetch(panelMessageId).catch(() => null);
    if (msg) return msg.edit({ embeds: [embed] });
  }

  const created = await channel.send({ embeds: [embed] });
  panelMessageId = created.id;
}

async function updatePresence() {
  let online = null, max = null;

  try {
    const data = await getCounts();
    online = data.online;
    max = data.max;
  } catch (e) {
    console.log('[RCON FAIL]', e?.message || e);
  }

  const value = (typeof online === 'number' && typeof max === 'number') ? `${online}/${max}` : '?';

  client.user?.setPresence({
    activities: [{ name: `Online: ${value} | ${MC_NAME}`, type: ActivityType.Watching }],
    status: 'online', // siempre verde
  });
}

// ----------- Interactions -----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'online') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const { online, max } = await getCounts();
      const value = (typeof online === 'number' && typeof max === 'number') ? `${online}/${max}` : '?';
      return interaction.editReply(`👥 Jugadores online: ${value}`);
    } catch (e) {
      return interaction.editReply(`👥 Jugadores online: ? (RCON falló)`);
    }
  }

  if (interaction.commandName === 'rawlist') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const raw = await rconSend('list');
      const cleaned = cleanMinecraftText(raw);
      const msg = cleaned.length > 1900 ? cleaned.slice(0, 1900) + '…' : cleaned;
      return interaction.editReply("```" + msg + "```");
    } catch (e) {
      return interaction.editReply(`No pude leer list por RCON: ${e?.message || e}`);
    }
  }
});

// ----------- Boot -----------
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
