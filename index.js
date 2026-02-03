import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, ActivityType } from 'discord.js';
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
  RCON_PORT = '25575',
  RCON_PASSWORD,
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Falta DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Falta CLIENT_ID');
if (!GUILD_ID) throw new Error('Falta GUILD_ID');
if (!RCON_HOST) throw new Error('Falta RCON_HOST');
if (!RCON_PASSWORD) throw new Error('Falta RCON_PASSWORD');

const app = express();
app.get('/', (_req, res) => res.status(200).send('Aurora SMP bot OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 HTTP listo en puerto ${PORT}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  { name: 'online', description: 'Muestra cuántos jugadores hay online (real, por RCON).' },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registrados/actualizados (guild).');
}

async function getOnlineCount() {
  const rcon = await Rcon.connect({
    host: RCON_HOST,
    port: Number(RCON_PORT),
    password: RCON_PASSWORD,
    timeout: 5000,
  });

  try {
    // /list devuelve algo como: "There are 1 of a max of 20 players online: Asirtic"
    const res = await rcon.send('list');
    const m = res.match(/There are (\d+) of a max of (\d+) players online/i);
    if (m) return { online: Number(m[1]), max: Number(m[2]), raw: res };
    // Fallback por si el idioma cambia
    const nums = res.match(/(\d+).+?(\d+)/);
    if (nums) return { online: Number(nums[1]), max: Number(nums[2]), raw: res };
    return { online: null, max: null, raw: res };
  } finally {
    try { await rcon.end(); } catch {}
  }
}

function buildEmbed(count) {
  const on = count?.online;
  const mx = count?.max;

  const embed = new EmbedBuilder()
    .setTitle(`📡 ${MC_NAME}`)
    .setDescription(`👥 **Jugadores online:** ${typeof on === 'number' ? `\`${on}/${mx ?? '—'}\`` : '`?`'}`)
    .setTimestamp(new Date());

  if (WEBSITE_URL) embed.addFields({ name: 'Web', value: WEBSITE_URL, inline: false });
  return embed;
}

let panelMessageId = null;

async function upsertPanel() {
  if (!STATUS_CHANNEL_ID) return;

  const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  let count;
  try {
    count = await getOnlineCount();
  } catch (e) {
    console.log('[RCON FAIL]', e?.message || e);
    count = { online: null, max: null };
  }

  const embed = buildEmbed(count);

  if (panelMessageId) {
    const msg = await channel.messages.fetch(panelMessageId).catch(() => null);
    if (msg) return msg.edit({ embeds: [embed] });
  }

  const created = await channel.send({ embeds: [embed] });
  panelMessageId = created.id;
}

async function updatePresence() {
  let count;
  try {
    count = await getOnlineCount();
  } catch {
    count = { online: null, max: null };
  }

  const on = count?.online;
  const mx = count?.max;

  client.user?.setPresence({
    activities: [
      {
        name: typeof on === 'number' ? `${on}/${mx ?? '—'} online | ${MC_NAME}` : `Online: ? | ${MC_NAME}`,
        type: ActivityType.Watching,
      },
    ],
    status: 'online', // SIEMPRE online (el bot está vivo)
  });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'online') {
    await interaction.deferReply();
    try {
      const count = await getOnlineCount();
      const on = count?.online;
      const mx = count?.max;
      return interaction.editReply(`👥 Jugadores online: ${typeof on === 'number' ? `${on}/${mx ?? '—'}` : '?'}`);
    } catch (e) {
      console.log('[RCON FAIL]', e?.message || e);
      return interaction.editReply('👥 Jugadores online: ? (RCON no disponible)');
    }
  }
});

client.once('ready', async () => {
  console.log(`🤖 Bot listo como ${client.user.tag}`);
  await registerCommands();

  const panelSec = Math.max(15, Number(STATUS_UPDATE_SECONDS || 60));
  const presSec = Math.max(15, Number(PRESENCE_UPDATE_SECONDS || 60));

  await upsertPanel();
  await updatePresence();

  if (STATUS_CHANNEL_ID) setInterval(() => upsertPanel().catch(console.error), panelSec * 1000);
  setInterval(() => updatePresence().catch(console.error), presSec * 1000);
});

client.login(DISCORD_TOKEN);
