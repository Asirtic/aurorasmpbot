import 'dotenv/config';
import express from 'express';
import net from 'net';
import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, ActivityType } from 'discord.js';
import { status as mcStatus } from 'mc-server-utilities';

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  MC_ADDRESS,
  MC_NAME = 'Aurora SMP',
  WEBSITE_URL,
  STATUS_CHANNEL_ID,
  STATUS_UPDATE_SECONDS = '60',
  PRESENCE_UPDATE_SECONDS = '60',
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID');
if (!GUILD_ID) throw new Error('Falta GUILD_ID');
if (!MC_ADDRESS) throw new Error('Falta MC_ADDRESS');

const MC_ADDR = MC_ADDRESS.trim();

// HTTP
const app = express();
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

// Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  { name: 'estado', description: 'Estado del servidor (online/offline, jugadores, versión).' },
  { name: 'online', description: 'Cuántos jugadores hay online (conteo real).' },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registrados/actualizados (guild).');
}

function parseAddress(addr) {
  const clean = (addr || '').trim();
  const [host, portRaw] = clean.split(':');
  const port = Number(portRaw);
  return { host, port: Number.isFinite(port) ? port : 25565 };
}

function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok, msg) => {
      try { socket.destroy(); } catch {}
      resolve({ ok, msg });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, `✅ TCP OK ${host}:${port}`));
    socket.once('timeout', () => done(false, `⏱️ TCP TIMEOUT ${host}:${port}`));
    socket.once('error', (e) => done(false, `❌ TCP ERROR ${host}:${port} -> ${e?.code || e?.message || e}`));
    socket.connect(port, host);
  });
}

let lastGood = null;

async function fetchServerStatus() {
  const { host, port } = parseAddress(MC_ADDR);

  const probe = await tcpProbe(host, port);
  console.log('[PROBE]', probe.msg);

  try {
    const res = await mcStatus(host, port, { timeout: 5000, enableSRV: true });
    const data = {
      online: true,
      players: { online: res.players?.online ?? 0, max: res.players?.max ?? 0 },
      version: res.version?.nameRaw ?? res.version?.name ?? 'Desconocida',
      motd: res.motd?.clean ?? null,
    };
    lastGood = data;
    console.log('[MC OK]', data);
    return data;
  } catch (err) {
    console.log('[MC FAIL]', err?.message || err);
    if (lastGood) return lastGood;
    return { online: false, players: { online: 0, max: 0 }, version: 'Desconocida' };
  }
}

function buildEmbed(data) {
  const online = Boolean(data?.online);
  const on = data?.players?.online ?? 0;
  const mx = data?.players?.max ?? 0;
  const version = data?.version ?? 'Desconocida';

  const embed = new EmbedBuilder()
    .setTitle(`📡 ${MC_NAME}`)
    .addFields(
      { name: 'Estado', value: online ? '🟢 Online' : '🔴 Offline', inline: true },
      { name: 'Jugadores', value: `${on}/${mx || '—'}`, inline: true },
      { name: 'Versión', value: String(version), inline: true },
      { name: 'IP', value: `\`${MC_ADDR}\``, inline: false },
    )
    .setTimestamp(new Date());

  if (WEBSITE_URL) embed.addFields({ name: 'Web', value: WEBSITE_URL, inline: false });
  if (data?.motd) embed.addFields({ name: 'MOTD', value: String(data.motd).slice(0, 900), inline: false });

  return embed;
}

let panelMessageId = null;

async function upsertPanel() {
  if (!STATUS_CHANNEL_ID) return;

  const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const data = await fetchServerStatus();
  const embed = buildEmbed(data);

  if (panelMessageId) {
    const msg = await channel.messages.fetch(panelMessageId).catch(() => null);
    if (msg) return msg.edit({ embeds: [embed] });
  }

  const created = await channel.send({ embeds: [embed] });
  panelMessageId = created.id;
}

async function updatePresence() {
  const data = await fetchServerStatus();
  const online = Boolean(data?.online);
  const on = data?.players?.online ?? 0;
  const mx = data?.players?.max ?? 0;

  client.user?.setPresence({
    activities: [{ name: online ? `${on}/${mx} online` : 'Servidor offline', type: ActivityType.Watching }],
    status: online ? 'online' : 'dnd',
  });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'estado') {
    await interaction.deferReply();
    const data = await fetchServerStatus();
    return interaction.editReply({ embeds: [buildEmbed(data)] });
  }

  if (interaction.commandName === 'online') {
    await interaction.deferReply();
    const data = await fetchServerStatus();
    if (!data?.online) return interaction.editReply('🔴 Offline.');
    return interaction.editReply(`🟢 Hay **${data.players.online}/${data.players.max}** online.`);
  }
});

client.once('ready', async () => {
  console.log(`🤖 Bot listo como ${client.user.tag}`);
  console.log(`📌 MC_ADDRESS usado: ${MC_ADDR}`);

  await registerCommands();

  const panelSec = Math.max(15, Number(STATUS_UPDATE_SECONDS || 60));
  const presSec = Math.max(15, Number(PRESENCE_UPDATE_SECONDS || 60));

  await upsertPanel();
  await updatePresence();

  if (STATUS_CHANNEL_ID) setInterval(() => upsertPanel().catch(console.error), panelSec * 1000);
  setInterval(() => updatePresence().catch(console.error), presSec * 1000);
});

client.login(DISCORD_TOKEN);
