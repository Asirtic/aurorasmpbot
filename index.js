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
  PermissionsBitField,
} from 'discord.js';

// =====================
// Config
// =====================
const DISCORD_INVITE_URL = 'https://discord.gg/yzZRu8yTF5';

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,

  MC_ADDRESS,
  MC_NAME = 'Aurora SMP',

  WEBSITE_URL,
  STORE_URL,

  STATUS_CHANNEL_ID,
  STATUS_UPDATE_SECONDS = '60',
  PRESENCE_UPDATE_SECONDS = '60',

  PANEL_THUMBNAIL_URL,
  PANEL_BANNER_URL,

  // Heartbeat via Discord (channel message JSON)
  HEARTBEAT_CHANNEL_ID,
  HEARTBEAT_STALE_SECONDS = '180',
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN en .env / variables de entorno');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID (Application ID) en .env / variables de entorno');
if (!GUILD_ID) throw new Error('Falta GUILD_ID (Server ID) en .env / variables de entorno');
if (!MC_ADDRESS) throw new Error('Falta MC_ADDRESS (ip:puerto o dominio:puerto)');

const STALE_SEC = Math.max(30, Number(HEARTBEAT_STALE_SECONDS || 180));

// =====================
// HTTP health (no es obligatorio exponerlo, pero ayuda en logs)
// =====================
const app = express();
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'aurora-smp-bot' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

// =====================
// Discord client
// =====================
// Nota: Para leer el contenido del mensaje del heartbeat por fetchMessages, NO hace falta el intent de MessageContent
// para eventos, pero en algunos casos Discord lo restringe. Recomendación: actívalo en Developer Portal.
// Aquí incluimos MessageContent para evitar sorpresas.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  { name: 'estado', description: 'Estado del servidor (online/offline, jugadores, versión).' },
  { name: 'online', description: 'Lista de jugadores online (si está disponible).' },
  { name: 'panel', description: 'Crea o reinicia el panel fijo en este canal (SOLO ADMIN).' },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registrados/actualizados (guild).');
}

// =====================
// Panel persistence
// =====================
const PANEL_STATE_FILE = path.join(process.cwd(), 'panel.json');

function loadPanelState() {
  try {
    if (!fs.existsSync(PANEL_STATE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(PANEL_STATE_FILE, 'utf8'));
    if (!parsed?.channelId || !parsed?.messageId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePanelState(channelId, messageId) {
  try {
    fs.writeFileSync(PANEL_STATE_FILE, JSON.stringify({ channelId, messageId }, null, 2));
  } catch (e) {
    console.error('No pude guardar panel.json:', e);
  }
}

// =====================
// Helpers
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

// =====================
// Heartbeat state (from Discord channel message JSON)
// =====================
const state = {
  source: 'none',     // none | discord
  lastUpdate: 0,
  online: false,
  playersOnline: 0,
  playersMax: 0,
  version: 'Desconocida',
  motd: null,
  list: [],
};

async function pullHeartbeatFromDiscord() {
  if (!HEARTBEAT_CHANNEL_ID) return;

  const channel = await client.channels.fetch(HEARTBEAT_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  // Traemos el mensaje más reciente
  const msgs = await channel.messages.fetch({ limit: 5 }).catch(() => null);
  if (!msgs || msgs.size === 0) return;

  // Elegimos el primero que parezca JSON (el plugin manda JSON plano)
  const candidate = msgs.find(m => m.content && m.content.trim().startsWith('{')) || msgs.first();
  if (!candidate?.content) return;

  let parsed;
  try {
    parsed = JSON.parse(candidate.content.trim());
  } catch {
    // Si viene en ```json ... ``` lo limpiamos
    const cleaned = candidate.content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    try { parsed = JSON.parse(cleaned); } catch { return; }
  }

  const online = Boolean(parsed.online);
  state.source = 'discord';
  state.lastUpdate = Number(parsed.t || parsed.time || Date.now()) || Date.now();
  // si el plugin manda epoch seconds
  if (state.lastUpdate < 10_000_000_000) state.lastUpdate *= 1000;

  state.online = online;
  state.playersOnline = Number(parsed.playersOnline ?? 0) || 0;
  state.playersMax = Number(parsed.playersMax ?? 0) || 0;
  state.version = String(parsed.version ?? 'Desconocida');
  state.motd = parsed.motd ? String(parsed.motd).slice(0, 1000) : null;

  const list = Array.isArray(parsed.list) ? parsed.list.map(x => String(x)).slice(0, 60) : [];
  state.list = list;
}

// =====================
// UI builders
// =====================
function buildButtons() {
  const web = normalizeUrl(WEBSITE_URL);
  const store = normalizeUrl(STORE_URL);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('💜 Discord').setURL(DISCORD_INVITE_URL),
  );

  if (web) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🌐 Web').setURL(web));
  if (store) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🛒 Tienda').setURL(store));

  row.addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`📌 ${MC_ADDRESS}`)
      .setURL(store || web || DISCORD_INVITE_URL),
  );

  return [row];
}

function buildEmbedFromState() {
  const ageMs = Date.now() - (state.lastUpdate || 0);
  const stale = state.source === 'discord' && ageMs > STALE_SEC * 1000;

  const online = !stale && Boolean(state.online);
  const playersOnline = !stale ? (state.playersOnline ?? 0) : 0;
  const playersMax = state.playersMax ?? 0;
  const version = state.version ?? 'Desconocida';

  const motdClean = state.motd ? String(state.motd).trim() : null;
  const list = Array.isArray(state.list) ? state.list.slice(0, 30) : [];

  const statusLabel = stale
    ? '🟠 NO VERIFICABLE'
    : (online ? '🟢 ONLINE' : '🔴 OFFLINE');

  const color = stale ? 0xf59e0b : (online ? 0x22c55e : 0xef4444);

  const titleUrl = normalizeUrl(WEBSITE_URL) || normalizeUrl(STORE_URL) || DISCORD_INVITE_URL;

  const desc = stale
    ? `**Estado:** ${statusLabel}\n**Última señal:** <t:${Math.floor((state.lastUpdate || Date.now()) / 1000)}:R>\n**Jugadores (último):** \`${state.playersOnline ?? 0}/${playersMax}\``
    : (online
        ? `**Estado:** ${statusLabel}\n**Jugadores:** \`${playersOnline}/${playersMax}\`\n\`${makeBar(playersOnline, playersMax)}\``
        : `**Estado:** ${statusLabel}\n**Jugadores:** \`0/${playersMax || '—'}\``);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`📡 ${MC_NAME}`)
    .setURL(titleUrl)
    .setDescription(desc)
    .addFields(
      {
        name: '🔌 Conexión',
        value: `**IP:** \`${MC_ADDRESS}\`\n**Versión:** \`${version}\``,
        inline: true,
      },
      {
        name: '🕒 Actualización',
        value: `**Ahora:** <t:${Math.floor(Date.now() / 1000)}:R>\n**Fuente:** \`${state.source}\``,
        inline: true,
      },
    )
    .setFooter({ text: 'Aurora SMP • Panel en vivo' })
    .setTimestamp(new Date());

  if (PANEL_THUMBNAIL_URL) embed.setThumbnail(PANEL_THUMBNAIL_URL);
  if (PANEL_BANNER_URL) embed.setImage(PANEL_BANNER_URL);

  if (motdClean) {
    embed.addFields({
      name: '📝 MOTD',
      value: '```' + motdClean.slice(0, 900) + '```',
      inline: false,
    });
  }

  if (!stale && online) {
    embed.addFields({
      name: `👥 Online (${playersOnline})`,
      value: list.length ? list.join(', ') : '_La lista no está disponible._',
      inline: false,
    });
  }

  const web = normalizeUrl(WEBSITE_URL);
  const store = normalizeUrl(STORE_URL);
  const links = [
    `💜 Discord: ${DISCORD_INVITE_URL}`,
    web ? `🌐 Web: ${web}` : null,
    store ? `🛒 Tienda: ${store}` : null,
  ].filter(Boolean);

  embed.addFields({ name: '🔗 Enlaces', value: links.join('\n').slice(0, 1024), inline: false });

  return embed;
}

// =====================
// Panel fixed message
// =====================
async function upsertPanel(forceChannelId = null, forceNew = false) {
  const saved = loadPanelState();
  const channelId = forceChannelId || saved?.channelId || STATUS_CHANNEL_ID;
  const messageId = forceNew ? null : (saved?.messageId || null);

  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  // refresh heartbeat before rendering
  await pullHeartbeatFromDiscord();

  const embed = buildEmbedFromState();
  const components = buildButtons();

  if (messageId) {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components });
      savePanelState(channelId, msg.id);
      return;
    }
  }

  const created = await channel.send({ embeds: [embed], components });
  savePanelState(channelId, created.id);
}

// =====================
// Presence
// =====================
async function updatePresence() {
  await pullHeartbeatFromDiscord();

  const ageMs = Date.now() - (state.lastUpdate || 0);
  const stale = state.source === 'discord' && ageMs > STALE_SEC * 1000;

  const online = !stale && Boolean(state.online);
  const playersOnline = !stale ? (state.playersOnline ?? 0) : 0;
  const playersMax = state.playersMax ?? 0;

  // El bot SIEMPRE verde (está vivo). Solo cambia el texto.
  client.user?.setPresence({
    activities: [
      {
        name: stale
          ? `🟠 No verificable | ${MC_NAME}`
          : (online ? `🟢 ${playersOnline}/${playersMax} | ${MC_NAME}` : `🔴 Offline | ${MC_NAME}`),
        type: 3, // Watching
      },
    ],
    status: 'online',
  });
}

// =====================
// Interactions
// =====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'estado') {
      await interaction.deferReply();
      await pullHeartbeatFromDiscord();
      await interaction.editReply({ embeds: [buildEmbedFromState()] });
      return;
    }

    if (interaction.commandName === 'online') {
      await interaction.deferReply();
      await pullHeartbeatFromDiscord();

      const ageMs = Date.now() - (state.lastUpdate || 0);
      const stale = state.source === 'discord' && ageMs > STALE_SEC * 1000;

      if (stale) return interaction.editReply('🟠 Estado no verificable ahora mismo (sin señal reciente).');
      if (!state.online) return interaction.editReply('🔴 El servidor está offline.');

      const list = Array.isArray(state.list) ? state.list : [];
      if (!list.length) return interaction.editReply('🟢 Online, pero no tengo lista de jugadores.');

      const msg = `👥 Online (${list.length}): ${list.join(', ')}`;
      return interaction.editReply(msg.length > 1900 ? msg.slice(0, 1900) + '…' : msg);
    }

    if (interaction.commandName === 'panel') {
      // SOLO ADMINISTRADOR
      const memberPerms = interaction.memberPermissions;
      const isAdmin = memberPerms?.has(PermissionsBitField.Flags.Administrator);

      if (!isAdmin) {
        await interaction.reply({ content: '⛔ Solo administradores pueden usar `/panel`.', ephemeral: true });
        return;
      }

      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: '⚠️ No puedo usar este canal.', ephemeral: true });
        return;
      }

      await interaction.reply({ content: '✅ Creando/Reiniciando panel en este canal...', ephemeral: true });
      await upsertPanel(channel.id, true);
      await interaction.editReply('✅ Panel listo. A partir de ahora se actualizará aquí.');
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

  // initial
  await upsertPanel();
  await updatePresence();

  // loops
  setInterval(() => upsertPanel().catch(console.error), panelSec * 1000);
  setInterval(() => updatePresence().catch(console.error), presSec * 1000);
});

client.login(DISCORD_TOKEN);
