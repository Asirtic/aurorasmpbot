# Aurora SMP — Discord Status Bot

Bot sencillo para Discord que añade:

- `/estado` — online/offline, jugadores, versión, dirección
- `/online` — lista de jugadores (si el servidor la expone)
- (Opcional) **panel fijo** en un canal que se actualiza solo
- (Opcional) cambia la **presencia** del bot a `X/Y online`

Este proyecto usa la API `mcsrvstat.us` para consultar el estado (requiere `User-Agent`).  
Docs de la API: https://api.mcsrvstat.us/  (no pegues tu token en público)

---

## Despliegue sin instalar nada (Render + UptimeRobot)

### A) Subir el proyecto a GitHub (solo web)
1. Crea un repo nuevo en GitHub.
2. **Upload files** (sube todo el contenido de esta carpeta excepto `.env`).
3. Commit.

### B) Crear el servicio en Render
1. Render → New → **Web Service**
2. Conecta tu repo de GitHub
3. Render detecta Node automáticamente.
4. Deja:
   - Build Command: `npm install`
   - Start Command: `npm start`

> Render Free **se duerme** tras 15 min sin tráfico: https://render.com/docs/free

### C) Variables de entorno (MUY IMPORTANTE)
En Render → Environment, añade:

- `DISCORD_TOKEN` = token del bot
- `CLIENT_ID` = Application ID (Developer Portal)
- `GUILD_ID` = Server ID (tu servidor de Discord)
- `MC_ADDRESS` = ip:puerto o dominio:puerto
- `MC_NAME` = Aurora SMP (o el nombre que quieras)

Opcional:
- `WEBSITE_URL`
- `STATUS_CHANNEL_ID` (ID del canal para panel fijo)
- `STATUS_UPDATE_SECONDS` (ej: 60)
- `PRESENCE_UPDATE_SECONDS` (ej: 60)

### D) Mantenerlo “24/7” gratis (UptimeRobot)
Crea un monitor HTTP a:
- `https://TU-APP.onrender.com/health`

UptimeRobot Free monitoriza cada **5 min**: https://uptimerobot.com/pricing/

---

## Consejos
- Si `/online` no muestra nombres, no es bug: depende de si tu servidor expone la lista en el “status ping”.
- Si quieres que SIEMPRE aparezcan nombres, el método “pro” es un plugin/endpoint propio en el servidor (te lo preparo cuando quieras).

---

## Archivos
- `index.js` — bot + endpoint /health
- `render.yaml` — config opcional para Blueprint (si usas Render Blueprint)
- `.env.example` — plantilla de variables de entorno
