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
// Config
// =====================
const DEFAULT_DISCORD_INVITE_URL = 'https://discord.gg/yzZRu8yTF5';
const DEFAULT_MODPACK_URL =
  'https://www.mediafire.com/file/99efzf43samiq5s/aurorasmpbyasirticmodsv115.rar/file';

const {
  DISCORD_TOKEN,
  CLIENT_ID,

  MC_ADDRESS,
  MC_NAME = 'Aurora SMP',

  WEBSITE_URL,
  STORE_URL,

  // Auto-panel opcional (si lo pones, al arrancar intenta crear/actualizar panel ahí)
  STATUS_CHANNEL_ID,
  STATUS_UPDATE_SECONDS = '60',
  PRESENCE_UPDATE_SECONDS = '60',

  PANEL_THUMBNAIL_URL,
  PANEL_BANNER_URL,

  // RCON (FUENTE REAL)
  RCON_HOST,
  RCON_PORT = '8056',
  RCON_PASSWORD,

  // Multi-guild registration
  GUILD_IDS,

  // Links override
  DISCORD_INVITE_URL = DEFAULT_DISCORD_INVITE_URL,
  MODPACK_URL = DEFAULT_MODPACK_URL,
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID');
if (!MC_ADDRESS) throw new Error('Falta MC_ADDRESS');
if (!RCON_HOST) throw new Error('Falta RCON_HOST');
if (!RCON_PASSWORD) throw new Error('Falta RCON_PASSWORD');
if (!GUILD_IDS) throw new Error('Falta GUILD_IDS (IDs separados por coma)');

// =====================
// HTTP health
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

// ✅ Comandos públicos
const commands = [
  { name: 'panel', description: 'Crea o reinicia el panel fijo en ESTE canal.' },
  { name: 'estado', description: 'Muestra el panel de estado aquí.' },
  { name: 'online', description: 'Muestra cuántos jugadores hay online.' },
  { name: 'rawlist', description: 'Devuelve el texto crudo de "list" por RCON (debug).' },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// ✅ RESET + re-register para limpiar permisos cacheados antiguos en cada guild
async function registerCommands() {
  const list = String(GUILD_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!list.length) throw new Error('Falta GUILD_IDS en .env');

  for (const gid of list) {
    // 1) borra comandos viejos (resetea permisos cacheados / restos)
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: [] });

    // 2) registra los nuevos
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: commands });

    console.log(`✅ Slash commands reseteados y registrados en guild ${gid}`);
  }
}

// =====================
// Panel persistence (1 panel por guild)
// =====================
// panel.json:
// { "byGuild": { "<guildId>": { "channelId": "...", "messageId": "..." } } }
const PANEL_STATE_FILE = path.join(process.cwd(), 'panel.json');

function loadPanelState() {
  try {
    if (!fs.existsSync(PANEL_STATE_FILE)) return { byGuild: {} };
    const parsed = JSON.parse(fs.readFileSync(PANEL_STATE_FILE, 'utf8'));
    if (!parsed?.byGuild || typeof parsed.byGuild !== 'object') return { byGuild: {} };
    return parsed;
  } catch {
    return { byGuild: {} };
  }
}

function savePanelState(allState) {
  try {
    fs.writeFileSync(PANEL_STATE_FILE, JSON.stringify(allState, null, 2));
  } catch (e) {
    console.error('No pude guardar panel.json:', e);
  }
}

function getGuildPanel(guildId) {
  const st = loadPanelState();
  return st.byGuild?.[guildId] || null;
}

function setGuildPanel(guildId, channelId, messageId) {
  const st = loadPanelState();
  st.byGuild = st.byGuild || {};
  st.byGuild[guildId] = { channelId, messageId };
  savePanelState(st);
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

// =====================
// RCON (fuente real de jugadores)
// =====================
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

function parseOnlineMaxFromList(raw) {
  const res = cleanMinecraftText(raw);

  // "Online Players 0/16: "
  let m = res.match(/Online Players\s*(\d+)\s*\/\s*(\d+)\s*:/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  // Vanilla:
  m = res.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  // Fallback:
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
// UI builders
// =====================
function buildButtons() {
  const web = normalizeUrl(WEBSITE_URL);
  const store = normalizeUrl(STORE_URL);
  const modpack = normalizeUrl(MODPACK_URL);
  const invite = normalizeUrl(DISCORD_INVITE_URL);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('💜 Discord').setURL(invite),
  );

  if (web) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🌐 Web').setURL(web));
  if (store) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🛒 Tienda').setURL(store));
  if (modpack) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('📦 Modpack').setURL(modpack));

  row.addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`📌 ${MC_ADDRESS}`)
      .setURL(store || web || invite),
  );

  return [row];
}

function buildEmbed(online, max) {
  const hasData = Number.isFinite(online) && Number.isFinite(max);

  const okGreen = 0x22c55e;
  const warnOrange = 0xf59e0b;

  const titleUrl = normalizeUrl(WEBSITE_URL) || normalizeUrl(STORE_URL) || normalizeUrl(DISCORD_INVITE_URL);

  const desc = hasData
    ? `**Jugadores:** \`${online}/${max}\`\n\`${makeBar(online, max)}\``
    : `**Jugadores:** \`?\`\n_El servidor no respondió a RCON en este momento._`;

  const embed = new EmbedBuilder()
    .setColor(hasData ? okGreen : warnOrange)
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
    `💜 Discord: ${normalizeUrl(DISCORD_INVITE_URL)}`,
    WEBSITE_URL ? `🌐 Web: ${normalizeUrl(WEBSITE_URL)}` : null,
    STORE_URL ? `🛒 Tienda: ${normalizeUrl(STORE_URL)}` : null,
    MODPACK_URL ? `📦 Modpack: ${normalizeUrl(MODPACK_URL)}` : null,
  ].filter(Boolean);

  embed.addFields({ name: '🔗 Enlaces', value: links.join('\n').slice(0, 1024), inline: false });

  return embed;
}

// =====================
// Panel fixed message (1 por guild)
// =====================
async function upsertPanel({ guildId, forceChannelId = null, forceNew = false } = {}) {
  if (!guildId) return;

  const saved = getGuildPanel(guildId);
  const channelId = forceChannelId || saved?.channelId || STATUS_CHANNEL_ID;
  const messageId = forceNew ? null : (saved?.messageId || null);

  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
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
  const components = buildButtons();

  if (messageId) {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components });
      setGuildPanel(guildId, channelId, msg.id);
      return;
    }
  }

  const created = await channel.send({ embeds: [embed], components });
  setGuildPanel(guildId, channelId, created.id);
}

// =====================
// Presence
// =====================
async function updatePresence() {
  let online = null, max = null;

  try {
    const data = await getCounts();
    online = data.online;
    max = data.max;
  } catch {}

  const value = (Number.isFinite(online) && Number.isFinite(max)) ? `${online}/${max}` : '?';

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
      const guildId = interaction.guildId;

      if (!guildId) {
        await interaction.reply({ content: '⚠️ Este comando solo funciona dentro de un servidor.', ephemeral: true });
        return;
      }
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: '⚠️ No puedo usar este canal.', ephemeral: true });
        return;
      }

      await interaction.reply({ content: '✅ Panel creado/reiniciado en este canal.', ephemeral: true });
      await upsertPanel({ guildId, forceChannelId: channel.id, forceNew: true });
      return;
    }

    if (interaction.commandName === 'estado') {
      await interaction.deferReply({ ephemeral: false });

      let online = null, max = null;
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
        const value = (Number.isFinite(online) && Number.isFinite(max)) ? `${online}/${max}` : '?';
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
        await interaction.editReply("```" + msg + "```");
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
// Boot
// =====================
client.once('ready', async () => {
  console.log(`🤖 Bot listo como ${client.user.tag}`);

  await registerCommands();

  const panelSec = Math.max(15, Number(STATUS_UPDATE_SECONDS || 60));
  const presSec = Math.max(15, Number(PRESENCE_UPDATE_SECONDS || 60));

  const guildIds = String(GUILD_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Auto-panel por guild si hay STATUS_CHANNEL_ID
  if (STATUS_CHANNEL_ID) {
    for (const gid of guildIds) {
      await upsertPanel({ guildId: gid }).catch(console.error);
    }
    setInterval(() => {
      for (const gid of guildIds) {
        upsertPanel({ guildId: gid }).catch(console.error);
      }
    }, panelSec * 1000);
  }

  await updatePresence();
  setInterval(() => updatePresence().catch(console.error), presSec * 1000);
});

client.login(DISCORD_TOKEN);
