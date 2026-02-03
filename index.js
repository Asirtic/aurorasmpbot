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
  ActivityType,
} from 'discord.js';
import { Rcon } from 'rcon-client';

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

  // RCON (FUENTE REAL)
  RCON_HOST,
  RCON_PORT = '8056',
  RCON_PASSWORD,
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID');
if (!GUILD_ID) throw new Error('Falta GUILD_ID');
if (!MC_ADDRESS) throw new Error('Falta MC_ADDRESS');
if (!RCON_HOST) throw new Error('Falta RCON_HOST');
if (!RCON_PASSWORD) throw new Error('Falta RCON_PASSWORD');

// =====================
// HTTP health
// =====================
const app = express();
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'aurora-smp-bot' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

// =====================
// Discord client (SOLO Guilds -> sin intents privilegiados)
// =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ✅ Todos los comandos solo admins (además se valida abajo)
const commands = [
  {
    name: 'panel',
    description: 'Crea o reinicia el panel fijo en este canal (SOLO ADMIN).',
    default_member_permissions: String(PermissionsBitField.Flags.Administrator),
  },
  {
    name: 'estado',
    description: 'Muestra el panel de estado (SOLO ADMIN).',
    default_member_permissions: String(PermissionsBitField.Flags.Administrator),
  },
  {
    name: 'online',
    description: 'Muestra jugadores online (SOLO ADMIN).',
    default_member_permissions: String(PermissionsBitField.Flags.Administrator),
  },
  {
    name: 'rawlist',
    description: 'Devuelve el texto crudo de "list" por RCON (SOLO ADMIN).',
    default_member_permissions: String(PermissionsBitField.Flags.Administrator),
  },
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

  // Tu formato real:
  // "Online Players 0/16: "
  let m = res.match(/Online Players\s*(\d+)\s*\/\s*(\d+)\s*:/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  // Vanilla:
  m = res.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online/i);
  if (m) return { online: Number(m[1]), max: Number(m[2]), cleaned: res };

  // Último recurso:
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
    console.log('[RCON CLEANED]', JSON.stringify(parsed.cleaned));
    console.log('[RCON PARSED]', parsed.online, parsed.max);
    lastLogKey = key;
  }

  return parsed;
}

// =====================
// UI builders (estética tipo IA)
// =====================
function buildButtons() {
  const web = normalizeUrl(WEBSITE_URL);
  const store = normalizeUrl(STORE_URL);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('💜 Discord').setURL(DISCORD_INVITE_URL),
  );

  if (web) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🌐 Web').setURL(web));
  if (store) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🛒 Tienda').setURL(store));

  // Discord no permite "abrir minecraft://" así que este botón solo muestra la IP como label
  row.addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`📌 ${MC_ADDRESS}`)
      .setURL(store || web || DISCORD_INVITE_URL),
  );

  return [row];
}

function buildEmbed(online, max) {
  const hasData = Number.isFinite(online) && Number.isFinite(max);

  // Colores: morado aurora base, verde si hay datos y el server responde
  const basePurple = 0x8b5bff;
  const okGreen = 0x22c55e;
  const warnOrange = 0xf59e0b;

  const color = hasData ? okGreen : warnOrange;

  const titleUrl = normalizeUrl(WEBSITE_URL) || normalizeUrl(STORE_URL) || DISCORD_INVITE_URL;

  const desc = hasData
    ? `**Jugadores:** \`${online}/${max}\`\n\`${makeBar(online, max)}\``
    : `**Jugadores:** \`?\`\n_El servidor no respondió a RCON en este momento._`;

  const embed = new EmbedBuilder()
    .setColor(hasData ? color : warnOrange)
    .setTitle(`📡 ${MC_NAME}`)
    .setURL(titleUrl)
    .setDescription(desc)
    .addFields(
      {
        name: '🔌 Conexión',
        value: `**IP:** \`${MC_ADDRESS}\`\n**RCON:** \`${RCON_HOST}:${RCON_PORT}\``,
        inline: true,
      },
      {
        name: '🕒 Actualización',
        value: `**Ahora:** <t:${Math.floor(Date.now() / 1000)}:R>`,
        inline: true,
      },
    )
    .setFooter({ text: 'Aurora SMP • Panel en vivo' })
    .setTimestamp(new Date());

  if (PANEL_THUMBNAIL_URL) embed.setThumbnail(PANEL_THUMBNAIL_URL);
  if (PANEL_BANNER_URL) embed.setImage(PANEL_BANNER_URL);

  if (WEBSITE_URL || STORE_URL) {
    const links = [
      `💜 Discord: ${DISCORD_INVITE_URL}`,
      WEBSITE_URL ? `🌐 Web: ${normalizeUrl(WEBSITE_URL)}` : null,
      STORE_URL ? `🛒 Tienda: ${normalizeUrl(STORE_URL)}` : null,
    ].filter(Boolean);

    embed.addFields({ name: '🔗 Enlaces', value: links.join('\n').slice(0, 1024), inline: false });
  }

  // Un toque "Aurora" aunque usemos verde/amarillo: línea decorativa con morado en el footer/title ya ayuda.
  // Si quieres, puedo ajustar todo a morado fijo.

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
      savePanelState(channelId, msg.id);
      return;
    }
  }

  const created = await channel.send({ embeds: [embed], components });
  savePanelState(channelId, created.id);
}

// =====================
// Presence (siempre verde, solo cambia texto)
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
// Admin check (para TODOS los comandos)
// =====================
function requireAdmin(interaction) {
  const perms = interaction.memberPermissions;
  const isAdmin = perms?.has(PermissionsBitField.Flags.Administrator);
  return Boolean(isAdmin);
}

// =====================
// Interactions
// =====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ✅ BLOQUEO TOTAL a no-admins
  if (!requireAdmin(interaction)) {
    await interaction.reply({ content: '⛔ Solo administradores pueden usar estos comandos.', ephemeral: true });
    return;
  }

  try {
    if (interaction.commandName === 'panel') {
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
      } catch (e) {
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
  console.log(`📌 RCON -> ${RCON_HOST}:${RCON_PORT}`);

  await registerCommands();

  const panelSec = Math.max(15, Number(STATUS_UPDATE_SECONDS || 60));
  const presSec = Math.max(15, Number(PRESENCE_UPDATE_SECONDS || 60));

  await upsertPanel();
  await updatePresence();

  setInterval(() => upsertPanel().catch(console.error), panelSec * 1000);
  setInterval(() => updatePresence().catch(console.error), presSec * 1000);
});

client.login(DISCORD_TOKEN);
