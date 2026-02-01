import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } from 'discord.js';

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

const app = express();

// Endpoint para keep-alive (Render Free se duerme si no hay tráfico)
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'aurora-smp-bot' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

// ---- Discord Client (solo slash commands) ----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  {
    name: 'estado',
    description: 'Estado del servidor (online/offline, jugadores, versión).',
  },
  {
    name: 'online',
    description: 'Lista de jugadores online (si está disponible).',
  },
  {
    name: 'panel',
    description: 'Crea o reinicia un panel fijo en este canal (admin).',
    default_member_permissions: '0', // por defecto solo admins con permisos podrán usarlo, se valida abajo
  },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Registro automático de comandos (GUILD: instantáneo)
async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log('✅ Slash commands registrados/actualizados en el servidor (guild).');
}

// ---- Minecraft status via mcsrvstat.us ----
async function fetchServerStatus() {
  // API requiere User-Agent no vacío o devuelve 403.
  const url = `https://api.mcsrvstat.us/3/${encodeURIComponent(MC_ADDRESS)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AuroraSMP-DiscordBot/1.0 (status)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} consultando estado`);
  return res.json();
}

function buildEmbed(data) {
  const online = Boolean(data?.online);
  const playersOnline = data?.players?.online ?? 0;
  const playersMax = data?.players?.max ?? 0;
  const version = data?.version ?? 'Desconocida';

  const motdClean = Array.isArray(data?.motd?.clean)
    ? data.motd.clean.join('\n')
    : null;

  const list = Array.isArray(data?.players?.list)
    ? data.players.list.map(p => (typeof p === 'string' ? p : (p?.name ?? String(p)))).slice(0, 50)
    : [];

  const embed = new EmbedBuilder()
    .setTitle(`📡 ${MC_NAME}`)
    .addFields(
      { name: 'Estado', value: online ? '🟢 Online' : '🔴 Offline', inline: true },
      { name: 'Jugadores', value: `${playersOnline}/${playersMax}`, inline: true },
      { name: 'Versión', value: String(version), inline: true },
      { name: 'Dirección', value: `\`${MC_ADDRESS}\``, inline: false },
    )
    .setTimestamp(new Date());

  if (WEBSITE_URL) {
    embed.addFields({ name: 'Web', value: WEBSITE_URL, inline: false });
  }

  if (motdClean) {
    embed.addFields({ name: 'MOTD', value: motdClean.slice(0, 900), inline: false });
  }

  if (online) {
    embed.addFields({
      name: `Online (${playersOnline})`,
      value: list.length ? list.join(', ').slice(0, 1000) : 'La lista no está disponible (depende del servidor).',
      inline: false,
    });
  }

  return embed;
}

// ---- Panel fijo (opcional) ----
let panelMessageId = null;

async function upsertPanel() {
  if (!STATUS_CHANNEL_ID) return;

  const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  let embed;
  try {
    const data = await fetchServerStatus();
    embed = buildEmbed(data);
  } catch {
    embed = new EmbedBuilder()
      .setTitle(`📡 ${MC_NAME}`)
      .setDescription('⚠️ No se pudo consultar el servidor ahora mismo.')
      .addFields({ name: 'Dirección', value: `\`${MC_ADDRESS}\`` })
      .setTimestamp(new Date());
  }

  if (panelMessageId) {
    const msg = await channel.messages.fetch(panelMessageId).catch(() => null);
    if (msg) return msg.edit({ embeds: [embed] });
  }

  const created = await channel.send({ embeds: [embed] });
  panelMessageId = created.id;
}

// ---- Presencia (opcional) ----
async function updatePresence() {
  try {
    const data = await fetchServerStatus();
    const online = Boolean(data?.online);
    const playersOnline = data?.players?.online ?? 0;
    const playersMax = data?.players?.max ?? 0;

    client.user?.setPresence({
      activities: [{ name: online ? `${playersOnline}/${playersMax} online` : 'Servidor offline', type: 3 }],
      status: online ? 'online' : 'dnd',
    });
  } catch {
    client.user?.setPresence({
      activities: [{ name: 'Estado no disponible', type: 3 }],
      status: 'idle',
    });
  }
}

// ---- Interactions ----
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
        await interaction.editReply('🔴 El servidor está offline.');
        return;
      }

      const list = Array.isArray(data?.players?.list)
        ? data.players.list.map(p => (typeof p === 'string' ? p : (p?.name ?? String(p))))
        : [];

      if (!list.length) {
        await interaction.editReply('🟢 Online, pero el servidor no expone lista de jugadores.');
        return;
      }

      // Discord tiene límite de longitud; enviamos un mensaje compacto
      const msg = `👥 Online (${list.length}): ${list.join(', ')}`;
      await interaction.editReply(msg.length > 1900 ? msg.slice(0, 1900) + '…' : msg);
      return;
    }

    if (interaction.commandName === 'panel') {
      // Permiso: solo admins o quien tenga Manage Guild
      const member = interaction.member;
      const hasPerm =
        member?.permissions?.has?.('ManageGuild') ||
        member?.permissions?.has?.('Administrator');

      if (!hasPerm) {
        await interaction.reply({ content: '⛔ No tienes permisos para usar esto.', ephemeral: true });
        return;
      }

      // crea/reinicia panel en el canal donde se ejecuta el comando
      panelMessageId = null;
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: '⚠️ No puedo usar este canal.', ephemeral: true });
        return;
      }

      // Si quieres panel en el canal actual, actualiza STATUS_CHANNEL_ID en variables de entorno.
      await interaction.reply({
        content:
          '✅ Panel reiniciado. **Ojo:** el panel automático se actualiza solo en el canal configurado como `STATUS_CHANNEL_ID`.',
        ephemeral: true,
      });
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

  await registerCommands();

  // panel + presencia
  const panelSec = Math.max(15, Number(STATUS_UPDATE_SECONDS || 60));
  const presSec = Math.max(15, Number(PRESENCE_UPDATE_SECONDS || 60));

  await upsertPanel();
  await updatePresence();

  if (STATUS_CHANNEL_ID) setInterval(upsertPanel, panelSec * 1000);
  setInterval(updatePresence, presSec * 1000);
});

client.login(DISCORD_TOKEN);
