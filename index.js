// index.js (COMPLETO) — Aurora SMP Status Bot
// ✅ Comandos GLOBAL (sirve en TODOS los servidores donde esté el bot)
// ✅ /panel usable por cualquiera en cualquier canal (sin admin)
// ✅ Panel bonito (estética IA) + botones + barra
// ✅ RCON como fuente real (jugadores online/max)
// ✅ NO muestra datos de RCON en el panel (solo IP pública MC)
// ✅ Multi-panel: guarda un panel por canal (panel_state.json)

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
} from 'discord.js';
import { Rcon } from 'rcon-client';

// =====================
// Config (.env)
// =====================
const DISCORD_INVITE_URL = process.env.DISCORD_INVITE_URL || 'https://discord.gg/yzZRu8yTF5';
const MODPACK_URL =
  process.env.MODPACK_URL ||
  'https://www.mediafire.com/file/99efzf43samiq5s/aurorasmpbyasirticmodsv115.rar/file';

const {
  DISCORD_TOKEN,
  CLIENT_ID,

  MC_ADDRESS,
  MC_NAME = 'Aurora SMP',

  WEBSITE_URL,
  STORE_URL,

  STATUS_UPDATE_SECONDS = '60',
  PRESENCE_UPDATE_SECONDS = '60',

  PANEL_THUMBNAIL_URL,
  PANEL_BANNER_URL,

  // RCON (FUENTE REAL)
  RCON_HOST,
  RCON_PORT = '8056',
  RCON_PASSWORD,
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID (Application ID)');
if (!MC_ADDRESS) throw new Error('Falta MC_ADDRESS (ip:puerto o dominio:puerto)');
if (!RCON_HOST) throw new Error('Falta RCON_HOST');
if (!RCON_PASSWORD) throw new Error('Falta RCON_PASSWORD');

// =====================
// HTTP health (para hosting)
// =====================
const app = express();
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'aurora-smp-bot' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

// =====================
// Discord client (sin intents privilegiados)
// =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// =====================
// Slash Commands (GLOBAL)
// =====================
const commands = [
  { name: 'panel', description: 'Crea o reinicia el panel en este canal.' },
  { name: 'estado', description: 'Muestra el estado actual (jugadores online).' },
  { name: 'online', description: 'Muestra jugadores online (contador).' },
  { name: 'rawlist', description: 'Devuelve el texto crudo de "list" por RCON (solo debug).' },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommandsGlobal() {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('✅ Slash commands registrados GLOBALMENTE (pueden tardar en aparecer en nuevos servers).');
}

// =====================
// Persistencia de paneles por canal
// =====================
const STATE_FILE = path.join(process.cwd(), 'panel_state.json');

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { panels: {} };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { panels: {} };
    if (!parsed.panels || typeof parsed.panels !== 'object') parsed.panels = {};
    return parsed;
  } catch {
    return { panels: {} };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('No pude guardar panel_state.json:', e);
  }
}

function setPanel(channelId, messageId) {
  const st = loadState();
  st.panels[channelId] = { messageId, updatedAt: Date.now() };
  saveState(st);
}

function getPanel(channelId) {
  const st = loadState();
  return st.panels?.[channelId] || null;
}

// =====================
// Helpers UI
// =====================
function normalizeUrl(u) {
  if (!u) return null;
  return u.startsWith('http://') || u.startsWith('https://') ? u : `https://${u}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function makeBar(current, max, size = 14) {
  const safeMax = max > 0 ? max : 1;
  const filled = Math.round((current / safeMax) * size);
  const f = clamp(filled, 0, size);
  return '█'.repeat(f) + '░'.repeat(size - f);
}

function cleanMinecraftText(s) {
  return String(s)
    .replace(/\x1b\[[0-9;]*m/g, '') // ANSI
    .replace(/§[0-9A-FK-OR]/gi, '') // Minecraft § codes
    .replace(/\r/g, '');
}

function buildButtons() {
  const web = normalizeUrl(WEBSITE_URL);
  const store = normalizeUrl(STORE_URL);
  const modpack = normalizeUrl(MODPACK_URL);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('💜 Discord').setURL(DISCORD_INVITE_URL),
  );

  if (web) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🌐 Web').setURL(web));
  if (store) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🛒 Tienda').setURL(store));
  if (modpack) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('📦 Modpack').setURL(modpack));

  // Botón IP (Discord no abre minecraft://, esto es solo visual)
  row.addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`📌 ${MC_ADDRESS}`)
      .setURL(store || web || DISCORD_INVITE_URL),
  );

  return [row];
}

// =====================
// RCON (fuente real)
// =====================
async function rconSend(cmd) {
  const rcon = await Rcon.connect({
    host: RCON_HOST,
    port: Number(RCON_PORT),
    password: RCON_PASSWORD,
    timeout: 6000,
  });

  try {
    return await rcon.send(cmd);
  } finally {
    try {
      await rcon.end();
    } catch {}
  }
}

function parseOnlineMaxFromList(raw) {
  const res = cleanMinecraftText(raw);

  // Plugins tipo "Online Players 0/16:"
  let m = res.match(/Online Players\s*(\d+)\s*\/\s*(\d+)\s*:/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  // Vanilla
  m = res.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  // Fallback genérico
  m = res.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  return { online: null, max: null, cleaned: res };
}

let lastLogKey = '';
async function getCounts() {
  const raw = await rconSend('list');
  const parsed = parseOnlineMaxFromList(raw);

  const key = `${parsed.online}/${parsed.max}`;
  if (key !== lastLogKey) {
    console.log('[RCON PARSED]', parsed.online, parsed.max);
    lastLogKey = key;
  }
  return parsed;
}

// =====================
// Embed (bonito, sin “OFFLINE” pesado)
// =====================
function buildEmbed(online, max) {
  const hasData = Number.isFinite(online) && Number.isFinite(max);

  const okPurple = 0x8b5bff;
  const warnOrange = 0xf59e0b;

  const titleUrl = normalizeUrl(WEBSITE_URL) || normalizeUrl(STORE_URL) || DISCORD_INVITE_URL;

  const desc = hasData
    ? `**👥 Jugadores:** \`${online}/${max}\`\n\`${makeBar(online, max)}\``
    : `**👥 Jugadores:** \`?\`\n_El servidor no respondió a RCON en este momento._`;

  const embed = new EmbedBuilder()
    .setColor(hasData ? okPurple : warnOrange)
    .setTitle(`📡 ${MC_NAME}`)
    .setURL(titleUrl)
    .setDescription(desc)
    .addFields(
      { name: '🔌 Conexión', value: `**IP:** \`${MC_ADDRESS}\``, inline: true },
      { name: '🕒 Actualización', value: `**Ahora:** <t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
    )
    .setFooter({ text: 'Aurora SMP • Panel en vivo' })
    .setTimestamp(new Date());

  if (PANEL_THUMBNAIL_URL) embed.setThumbnail(PANEL_THUMBNAIL_URL);
  if (PANEL_BANNER_URL) embed.setImage(PANEL_BANNER_URL);

  const links = [
    `💜 Discord: ${DISCORD_INVITE_URL}`,
    WEBSITE_URL ? `🌐 Web: ${normalizeUrl(WEBSITE_URL)}` : null,
    STORE_URL ? `🛒 Tienda: ${normalizeUrl(STORE_URL)}` : null,
    MODPACK_URL ? `📦 Modpack: ${normalizeUrl(MODPACK_URL)}` : null,
  ].filter(Boolean);

  embed.addFields({ name: '🔗 Enlaces', value: links.join('\n').slice(0, 1024), inline: false });

  return embed;
}

// =====================
// Panel en un canal específico
// =====================
async function upsertPanelInChannel(channelId, forceNew = false) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  let online = null,
    max = null;

  try {
    const data = await getCounts();
    online = data.online;
    max = data.max;
  } catch (e) {
    console.log('[RCON FAIL]', e?.message || e);
  }

  const embed = buildEmbed(online, max);
  const components = buildButtons();

  const saved = getPanel(channelId);
  const messageId = forceNew ? null : saved?.messageId || null;

  if (messageId) {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components });
      setPanel(channelId, msg.id);
      return;
    }
  }

  const created = await channel.send({ embeds: [embed], components });
  setPanel(channelId, created.id);
}

// =====================
// Presencia
// =====================
async function updatePresence() {
  let online = null,
    max = null;

  try {
    const data = await getCounts();
    online = data.online;
    max = data.max;
  } catch {}

  const value = Number.isFinite(online) && Number.isFinite(max) ? `${online}/${max}` : '?';

  client.user?.setPresence({
    activities: [{ name: `Online: ${value} | ${MC_NAME}`, type: ActivityType.Watching }],
    status: 'online',
  });
}

// =====================
// Interactions
// =====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'panel') {
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: '⚠️ No puedo usar este canal.', ephemeral: true });
        return;
      }

      await interaction.reply({ content: '✅ Creando/Reiniciando panel en este canal...', ephemeral: true });
      await upsertPanelInChannel(channel.id, true);
      await interaction.editReply('✅ Panel listo. Se actualizará automáticamente.');
      return;
    }

    if (interaction.commandName === 'estado') {
      await interaction.deferReply({ ephemeral: true });

      let online = null,
        max = null;
      try {
        const data = await getCounts();
        online = data.online;
        max = data.max;
      } catch {}

      await interaction.editReply({ embeds: [buildEmbed(online, max)], components: buildButtons() });
      return;
    }

    if (interaction.commandName === 'online') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const { online, max } = await getCounts();
        const value = Number.isFinite(online) && Number.isFinite(max) ? `${online}/${max}` : '?';
        await interaction.editReply(`👥 Jugadores online: **${value}**`);
      } catch {
        await interaction.editReply('👥 Jugadores online: **?** (RCON no respondió)');
      }
      return;
    }

    if (interaction.commandName === 'rawlist') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const raw = await rconSend('list');
        const cleaned = cleanMinecraftText(raw);
        const msg = cleaned.length > 1900 ? cleaned.slice(0, 1900) + '…' : cleaned;
        await interaction.editReply('```' + msg + '```');
      } catch (e) {
        await interaction.editReply(`No pude leer "list" por RCON: ${e?.message || e}`);
      }
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('⚠️ Ocurrió un error.');
    } else {
      await interaction.reply({ content: '⚠️ Ocurrió un error.', ephemeral: true });
    }
  }
});

// =====================
// Auto-update de paneles guardados
// =====================
async function refreshAllPanels() {
  const st = loadState();
  const channelIds = Object.keys(st.panels || {});
  if (!channelIds.length) return;

  for (const cid of channelIds) {
    await upsertPanelInChannel(cid, false).catch(() => {});
  }
}

// =====================
// Boot
// =====================
client.once('ready', async () => {
  console.log(`🤖 Bot listo como ${client.user.tag}`);

  await registerCommandsGlobal();

  const panelSec = Math.max(15, Number(STATUS_UPDATE_SECONDS || 60));
  const presSec = Math.max(15, Number(PRESENCE_UPDATE_SECONDS || 60));

  // Primer refresco (si ya existían paneles)
  await refreshAllPanels();
  await updatePresence();

  setInterval(() => refreshAllPanels().catch(() => {}), panelSec * 1000);
  setInterval(() => updatePresence().catch(() => {}), presSec * 1000);
});

client.login(DISCORD_TOKEN);
