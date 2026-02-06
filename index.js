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
// ENV
// =====================
const {
  DISCORD_TOKEN,
  CLIENT_ID,

  // Multi-guild registration (comma separated)
  GUILD_IDS,

  MC_ADDRESS,
  MC_NAME = 'Aurora SMP',

  WEBSITE_URL,
  STORE_URL,
  DISCORD_INVITE_URL,   // opcional

  // Panel defaults (opcional)
  STATUS_CHANNEL_ID,
  STATUS_UPDATE_SECONDS = '60',
  PRESENCE_UPDATE_SECONDS = '60',

  PANEL_THUMBNAIL_URL,
  PANEL_BANNER_URL,

  // Modpack link (Mediafire)
  MODPACK_URL,

  // RCON
  RCON_HOST,
  RCON_PORT = '8056',
  RCON_PASSWORD,
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID');
if (!GUILD_IDS) throw new Error('Falta GUILD_IDS (IDs separados por coma)');
if (!MC_ADDRESS) throw new Error('Falta MC_ADDRESS');
if (!RCON_HOST) throw new Error('Falta RCON_HOST');
if (!RCON_PASSWORD) throw new Error('Falta RCON_PASSWORD');

// =====================
// HTTP keep-alive
// =====================
const app = express();
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'aurora-smp-bot' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

// =====================
// Discord client (sin intents privilegiados)
// =====================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// =====================
// Commands (PÚBLICOS)
// =====================
const commands = [
  { name: 'panel', description: 'Crea o reinicia el panel fijo en ESTE canal.' },
  { name: 'estado', description: 'Muestra el estado del servidor (embed).' },
  { name: 'online', description: 'Muestra cuántos jugadores hay online.' },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

function parseGuildIds() {
  return String(GUILD_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

async function registerCommands() {
  const ids = parseGuildIds();
  console.log(`🧾 Registrando comandos en ${ids.length} guild(s): ${ids.join(', ')}`);

  for (const gid of ids) {
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID), { body: commands });
      console.log(`✅ Commands OK en guild ${gid}`);
    } catch (e) {
      // ESTO ES CLAVE: si el bot NO está dentro de ese servidor, te dará 403 Missing Access
      console.error(`❌ No pude registrar en guild ${gid}:`, e?.rawError || e?.message || e);
    }
  }
}

// =====================
// Panel persistence (POR GUILD)
// =====================
const PANEL_STATE_FILE = path.join(process.cwd(), 'panel.json');

/**
 * Estructura:
 * {
 *   "<guildId>": { "channelId": "...", "messageId": "..." },
 *   "<guildId2>": { ... }
 * }
 */
function loadPanelState() {
  try {
    if (!fs.existsSync(PANEL_STATE_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(PANEL_STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePanelState(all) {
  try {
    fs.writeFileSync(PANEL_STATE_FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.error('No pude guardar panel.json:', e?.message || e);
  }
}

function setPanelForGuild(guildId, channelId, messageId) {
  const all = loadPanelState();
  all[guildId] = { channelId, messageId };
  savePanelState(all);
}

function getPanelForGuild(guildId) {
  const all = loadPanelState();
  return all[guildId] || null;
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
    .replace(/\x1b\[[0-9;]*m/g, '')      // ANSI
    .replace(/§[0-9A-FK-OR]/gi, '')     // Minecraft § codes
    .replace(/\r/g, '');
}

// =====================
// RCON
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
    try { await rcon.end(); } catch {}
  }
}

function parseOnlineMaxFromList(raw) {
  const res = cleanMinecraftText(raw);

  // "Online Players 0/16: "
  let m = res.match(/Online Players\s*(\d+)\s*\/\s*(\d+)\s*:/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]) };

  // Vanilla: "There are X of a max of Y players online"
  m = res.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]) };

  // fallback
  m = res.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return { online: Number(m[1]), max: Number(m[2]) };

  return { online: null, max: null };
}

let lastKey = '';
async function getCounts() {
  const raw = await rconSend('list');
  const { online, max } = parseOnlineMaxFromList(raw);

  const key = `${online}/${max}`;
  if (key !== lastKey) {
    console.log('[RCON PARSED]', online, max);
    lastKey = key;
  }
  return { online, max };
}

// =====================
// Buttons + Embed (bonito)
// =====================
function buildButtons() {
  const web = normalizeUrl(WEBSITE_URL);
  const store = normalizeUrl(STORE_URL);
  const discord = normalizeUrl(DISCORD_INVITE_URL);
  const modpack = normalizeUrl(MODPACK_URL);

  const row = new ActionRowBuilder();

  if (discord) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('💜 Discord').setURL(discord));
  if (web) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🌐 Web').setURL(web));
  if (store) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🛒 Tienda').setURL(store));
  if (modpack) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('📦 Modpack').setURL(modpack));

  // IP como “label”
  row.addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`📌 ${MC_ADDRESS}`)
      .setURL(store || web || discord || modpack || 'https://discord.com')
  );

  return row.components.length ? [row] : [];
}

function buildEmbed(online, max) {
  const hasData = Number.isFinite(online) && Number.isFinite(max);

  const okGreen = 0x22c55e;
  const warnOrange = 0xf59e0b;

  const titleUrl =
    normalizeUrl(WEBSITE_URL) ||
    normalizeUrl(STORE_URL) ||
    normalizeUrl(DISCORD_INVITE_URL) ||
    normalizeUrl(MODPACK_URL) ||
    null;

  const desc = hasData
    ? `**Jugadores:** \`${online}/${max}\`\n\`${makeBar(online, max)}\``
    : `**Jugadores:** \`?\`\n_El servidor no respondió a RCON en este momento._`;

  const embed = new EmbedBuilder()
    .setColor(hasData ? okGreen : warnOrange)
    .setTitle(`📡 ${MC_NAME}`)
    .setDescription(desc)
    .addFields(
      { name: '🔌 Conexión', value: `**IP:** \`${MC_ADDRESS}\``, inline: true },
      { name: '🕒 Actualización', value: `**Ahora:** <t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
    )
    .setFooter({ text: 'Aurora SMP • Panel en vivo' })
    .setTimestamp(new Date());

  if (titleUrl) embed.setURL(titleUrl);
  if (PANEL_THUMBNAIL_URL) embed.setThumbnail(PANEL_THUMBNAIL_URL);
  if (PANEL_BANNER_URL) embed.setImage(PANEL_BANNER_URL);

  const links = [
    DISCORD_INVITE_URL ? `💜 Discord: ${normalizeUrl(DISCORD_INVITE_URL)}` : null,
    WEBSITE_URL ? `🌐 Web: ${normalizeUrl(WEBSITE_URL)}` : null,
    STORE_URL ? `🛒 Tienda: ${normalizeUrl(STORE_URL)}` : null,
    MODPACK_URL ? `📦 Modpack: ${normalizeUrl(MODPACK_URL)}` : null,
  ].filter(Boolean);

  if (links.length) embed.addFields({ name: '🔗 Enlaces', value: links.join('\n').slice(0, 1024), inline: false });

  return embed;
}

// =====================
// Panel update
// =====================
async function upsertPanelInChannel(guildId, channelId, forceNew = false) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const saved = getPanelForGuild(guildId);
  const oldMessageId = !forceNew ? saved?.messageId : null;

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

  if (oldMessageId) {
    const msg = await channel.messages.fetch(oldMessageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components });
      setPanelForGuild(guildId, channelId, msg.id);
      return;
    }
  }

  const created = await channel.send({ embeds: [embed], components });
  setPanelForGuild(guildId, channelId, created.id);
}

async function updateAllPanelsTick() {
  const all = loadPanelState();
  const entries = Object.entries(all);

  for (const [guildId, { channelId }] of entries) {
    if (!guildId || !channelId) continue;
    await upsertPanelInChannel(guildId, channelId, false).catch(() => {});
  }
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
// Interactions (PÚBLICOS)
// =====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'panel') {
      const channel = interaction.channel;
      const guildId = interaction.guildId;

      if (!guildId) {
        await interaction.reply({ content: '⚠️ Este comando solo funciona en servidores (no en DM).', ephemeral: true });
        return;
      }

      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: '⚠️ No puedo usar este canal.', ephemeral: true });
        return;
      }

      await interaction.reply({ content: '✅ Panel creado/actualizado en este canal.', ephemeral: true });
      await upsertPanelInChannel(guildId, channel.id, true);
      return;
    }

    if (interaction.commandName === 'estado') {
      await interaction.deferReply({ ephemeral: true });

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

  // MUY IMPORTANTE: registra comandos y loguea si falla en un guild (missing access)
  await registerCommands();

  // Si quieres que al arrancar cree un panel por defecto:
  // - si STATUS_CHANNEL_ID existe, lo pone SOLO en ese canal del GUILD_ID que lo invoque con /panel,
  // - pero aquí no sabemos el guild, así que esto solo sirve si ya existe panel.json.
  // De todas formas, si quieres “autopanel” en un canal fijo, usa /panel una vez en ese canal.

  const panelSec = Math.max(15, Number(STATUS_UPDATE_SECONDS || 60));
  const presSec = Math.max(15, Number(PRESENCE_UPDATE_SECONDS || 60));

  await updatePresence();
  setInterval(() => updateAllPanelsTick().catch(() => {}), panelSec * 1000);
  setInterval(() => updatePresence().catch(() => {}), presSec * 1000);

  console.log('✅ Loops activos: panel y presence.');
});

client.login(DISCORD_TOKEN);
