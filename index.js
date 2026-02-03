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

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN en .env / variables de entorno');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID (Application ID) en .env / variables de entorno');
if (!GUILD_ID) throw new Error('Falta GUILD_ID (Server ID) en .env / variables de entorno');
if (!MC_ADDRESS) throw new Error('Falta MC_ADDRESS (ip:puerto o dominio:puerto)');

const MC_ADDR = MC_ADDRESS.trim();

// -------------------- HTTP keep-alive --------------------
const app = express();
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'aurora-smp-bot' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

// -------------------- Discord --------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  { name: 'estado', description: 'Estado del servidor (online/offline, jugadores, versión).' },
  { name: 'online', description: 'Cuántos jugadores hay online (conteo real).' },
  {
    name: 'panel',
    description: 'Crea o reinicia un panel fijo en este canal (admin).',
    default_member_permissions: '0',
  },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registrados/actualizados (guild).');
}

// -------------------- Utilidades --------------------
function parseAddress(addr) {
  const clean = (addr || '').trim();
  if (!clean.includes(':')) return { host: clean, port: 25565 };
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

// Cache para no “parpadear” si falla una consulta puntual
let lastGood = null;

async function fetchServerStatus() {
  const { host, port } = parseAddress(MC_ADDR);

  // Diagnóstico simple de red (se imprime en logs)
  const probe = await tcpProbe(host, port);
  console.log('[PROBE]', probe.msg);

  try {
    // mc-server-utilities (fork) usa API muy similar a minecraft-server-util. :contentReference[oaicite:1]{index=1}
    const res = await mcStatus(host, port, { timeout: 5000, enableSRV: true });

    const data = {
      online: true,
      players: { online: res.players?.online ?? 0, max: res.players?.max ?? 0 },
      version: res.version?.nameRaw ?? res.version?.name ?? 'Desconocida',
      motd: { clean: [res.motd?.clean ?? ''] },
    };

    lastGood = data;
    console.log('[MC OK]', { host, port, online: data.players.online, max: data.players.max, ver: data.version });
    return data;
  } catch (err) {
    console.log('[MC FAIL]', { host, port, err: err?.message || err });

    if (lastGood) return lastGood;
    return { online: false };
  }
}

function buildEmbed(data) {
  const online = Boolean(data?.online);
  const playersOnline = data?.players?.online ?? 0;
  const playersMax = data?.players?.max ?? 0;
  const version = data?.version ?? 'Desconocida';

  const motdClean = Array.isArray(data?.motd?.clean)
    ? data.motd.clean.join('\n').trim()
    : null;

  const embed = new EmbedBuilder()
    .setTitle(`📡 ${MC_NAME}`)
    .addFields(
      { name: 'Estado', value: online ? '🟢 Online' : '🔴 Offline', inline: true },
      { name: 'Jugadores', value: `${playersOnline}/${playersMax}`, inline: true },
      { name: 'Versión', value: String(version), inline: true },
      { name: 'Dirección', value: `\`${MC_ADDR}\``, inline: false },
    )
    .setTimestamp(new Date());

  if (WEBSITE_URL) embed.addFields({ name: 'Web', value: WEBSITE_URL, inline: false });
  if (motdClean) embed.addFields({ name: 'MOTD', value: motdClean.slice(0, 900), inline: false });

  if (online) {
    embed.addFields({
      name: `Online (${playersOnline})`,
      value: '✅ Conteo real. (La lista de nombres requiere Query o RCON.)',
      inline: false,
    });
  }

  return embed;
}

// -------------------- Panel fijo --------------------
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

// -------------------- Presencia --------------------
async function updatePresence() {
  const data = await fetchServerStatus();
  const online = Boolean(data?.online);
  const playersOnline = data?.players?.online ?? 0;
  const playersMax = data?.players?.max ?? 0;

  client.user?.setPresence({
    activities: [
      { name: online ? `${playersOnline}/${playersMax} online` : 'Servidor offline', type: ActivityType.Watching },
    ],
    status: online ? 'online' : 'dnd',
  });
}

// -------------------- Interactions --------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'estado') {
      await interaction.deferReply();
      const data = await fetchServerStatus();
      await interaction.editReply({ embeds: [buildEmbed(data)] });
      return;
    }

    if (interaction.commandName === 'online') {
      await interaction.deferReply();
      const data = await fetchServerStatus();

      if (!data?.online) {
        await interaction.editReply('🔴 El servidor está offline (o no responde al ping).');
        return;
      }

      const on = data?.players?.online ?? 0;
      const mx = data?.players?.max ?? 0;
      await interaction.editReply(`🟢 Hay **${on}/${mx}** jugadores online ahora mismo.`);
      return;
    }

    if (interaction.commandName === 'panel') {
      const member = interaction.member;
      const hasPerm =
        member?.permissions?.has?.('ManageGuild') ||
        member?.permissions?.has?.('Administrator');

      if (!hasPerm) {
        await interaction.reply({ content: '⛔ No tienes permisos para usar esto.', ephemeral: true });
        return;
      }

      panelMessageId = null;
      await interaction.reply({ content: '✅ Panel reiniciado.', ephemeral: true });
      await upsertPanel();
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

client.once('ready', async () => {
  console.log(`🤖 Bot listo como ${client.user.tag}`);
  console.log('📌 MC_ADDRESS usado:', MC_ADDR);

  await registerCommands();

  const panelSec = Math.max(15, Number(STATUS_UPDATE_SECONDS || 60));
  const presSec = Math.max(15, Number(PRESENCE_UPDATE_SECONDS || 60));

  await upsertPanel();
  await updatePresence();

  if (STATUS_CHANNEL_ID) setInterval(upsertPanel, panelSec * 1000);
  setInterval(updatePresence, presSec * 1000);
});

client.login(DISCORD_TOKEN);
