const dotenv = require("dotenv");
dotenv.config();

const { google } = require("googleapis");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const fs = require("fs");
const qrcode = require("qrcode-terminal");
const chrono = require("chrono-node");

// CONFIGURA ESTO 👇
const NUMERO_ADMIN = "521XXXXXXXXXX@s.whatsapp.net"; // Tu número de admin
const dias = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const horas = [
  "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00",
  "17:00", "18:00", "19:00"
];
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const TIMEZONE = process.env.TIMEZONE || "America/Mexico_City";
const CREDENTIALS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.GoogleAuth({
  credentials: CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/calendar"]
});
const sheets = google.sheets({ version: "v4", auth });
const calendar = google.calendar({ version: "v3", auth });

const sessions = {};
const palabrasBloqueo = ["asesor", "humano", "ayuda personal", "quiero hablar con", "atención personal"];

// --- Utilidades Calendar
async function buscarYEliminarEvento(nombre, sender) {
  const list = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: (new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).toISOString(),
    maxResults: 15,
    singleEvents: true,
    orderBy: 'startTime'
  });
  // Busca por nombre y sender en descripción
  const event = list.data.items.find(e =>
    e.summary && e.summary.includes(nombre) && e.description && e.description.includes(sender)
  );
  if (event) {
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: event.id });
  }
}

// --- Utilidades fechas
function getNextDate(diaTexto, horaTexto, horasExtra = 0) {
  const diasMap = {
    lunes: 1, martes: 2, miércoles: 3, jueves: 4,
    viernes: 5, sábado: 6, domingo: 0
  };
  const ahora = new Date();
  const diaDeseado = diasMap[diaTexto];
  const resultado = new Date(ahora);
  resultado.setDate(ahora.getDate() + ((7 + diaDeseado - ahora.getDay()) % 7 || 7));
  const [h, m] = horaTexto.split(":").map(Number);
  resultado.setHours(h + horasExtra, m, 0, 0);
  return resultado.toISOString();
}
function formatDate(diaTexto) {
  const diasMap = {
    lunes: 1, martes: 2, miércoles: 3, jueves: 4,
    viernes: 5, sábado: 6, domingo: 0
  };
  const fecha = new Date();
  const targetDay = diasMap[diaTexto];
  const dayDiff = (7 + targetDay - fecha.getDay()) % 7 || 7;
  fecha.setDate(fecha.getDate() + dayDiff);
  return `${fecha.getDate()} de ${fecha.toLocaleString('es-MX', { month: 'long' })}`;
}

// --- Main Bot
const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const sock = makeWASocket({ auth: state });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startSock();
    } else if (connection === "open") {
      console.log("✅ Conectado a WhatsApp");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Sheets helpers
  const getCitas = async () => {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Citas!A2:F1000"
    });
    return res.data.values || [];
  };
  const hasCita = async (sender) => {
    const citas = await getCitas();
    return citas.find((row, i) => row[3] === sender && row[4] === 'activa' ? (row.index = i, true) : false);
  };

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const sender = msg.key.remoteJid;
    const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const text = rawText.trim();

    // Crea sesión para el usuario
    if (!sessions[sender]) sessions[sender] = { step: 0, errores: 0, bloqueado: false };
    const user = sessions[sender];
    if (user.bloqueado) return;

    // 1️⃣ -- FLUJO DE BLOQUEO POR HUMANO/ASESOR --
    if (palabrasBloqueo.some(p => text.toLowerCase().includes(p))) {
      user.bloqueado = true;
      await sock.sendMessage(sender, { text: "Un asesor humano se pondrá en contacto contigo pronto. 👤" });
      // Notifica al admin
      await sock.sendMessage(NUMERO_ADMIN, {
        text: `Hola, un cliente ha solicitado información personalizada:\n\n• Nombre: ${user.nombre || "No especificado"}\n• Teléfono: ${sender.replace("@s.whatsapp.net", "")}`
      });
      return;
    }

    // 2️⃣ -- SOLO OPCIONES NUMÉRICAS --
    // Si ya tiene cita activa, pregunta: 1. Reagendar 2. Cancelar
    if (user.step === 0) {
      const cita = await hasCita(sender);
      if (cita) {
        await sock.sendMessage(sender, {
          text: `Hola de nuevo ${cita[2]} 👋\n📅 Ya tienes una cita agendada el *${cita[0]} ${formatDate(cita[0])} a las ${cita[1]}*.\n\n1️⃣ Reagendar\n2️⃣ Cancelar\n\nResponde con el número de la opción deseada.`
        });
        user.step = 10;
        return;
      }
      await sock.sendMessage(sender, {
        text: "¡Hola! 👋 Soy *Bot Citas*. ¿Me puedes compartir tu *nombre completo* para agendar tu cita?"
      });
      user.step = 1;
      return;
    }

    // 3️⃣ -- FLUJO CANCELAR/REAGENDAR SOLO NÚMEROS --
    if (user.step === 10) {
      const cita = await hasCita(sender);
      if (!cita) {
        user.step = 0;
        await sock.sendMessage(sender, { text: "No tienes ninguna cita activa." });
        return;
      }
      if (text === "1") { // REAGENDAR
        user.nombre = cita[2];
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Citas!E${cita.index + 2}`,
          valueInputOption: "RAW",
          requestBody: { values: [["reagendada"]] },
        });
        await buscarYEliminarEvento(cita[2], sender);
        await sock.sendMessage(sender, {
          text: "📅 *Elige el nuevo día de tu cita:*\n" + dias.map((d, i) => `${i + 1}: ${d}`).join("\n") + "\n\nResponde solo con el número."
        });
        user.step = 2;
        return;
      }
      if (text === "2") { // CANCELAR
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Citas!E${cita.index + 2}`,
          valueInputOption: "RAW",
          requestBody: { values: [["cancelada"]] },
        });
        await buscarYEliminarEvento(cita[2], sender);
        await sock.sendMessage(sender, { text: "❌ Tu cita ha sido cancelada exitosamente." });
        user.step = 0;
        return;
      }
      await sock.sendMessage(sender, { text: "Opción inválida. Solo responde con '1' o '2'." });
      return;
    }

    // 4️⃣ -- FLUJO PRINCIPAL DE AGENDADO --
    switch (user.step) {
      case 1: { // Nombre
        user.nombre = rawText;
        await sock.sendMessage(sender, {
          text: "📅 *Elige el día de tu cita:*\n" + dias.map((d, i) => `${i + 1}: ${d}`).join("\n") + "\n\nResponde solo con el número."
        });
        user.step = 2;
        break;
      }
      case 2: { // Día
        const diaIndex = parseInt(text);
        if (isNaN(diaIndex) || diaIndex < 1 || diaIndex > dias.length) {
          await sock.sendMessage(sender, { text: "❌ Día inválido. Escribe un número del 1 al 7." });
          return;
        }
        user.dia = dias[diaIndex - 1];
        const citas = await getCitas();
        const ocupadas = citas.filter(c => c[0] === user.dia && c[4] === 'activa').map(c => c[1]);
        const disponibles = horas.filter(h => !ocupadas.includes(h));
        if (disponibles.length === 0) {
          await sock.sendMessage(sender, { text: `❌ No hay horarios disponibles para *${user.dia}*. Por favor elige otro día (número 1-7).` });
          return;
        }
        user.horasDisponibles = disponibles;
        await sock.sendMessage(sender, {
          text: `⏰ *Selecciona la hora de tu cita:*\n` + disponibles.map((h, i) => `${i + 1}: ${h}`).join(" | ") + "\n\nResponde solo con el número."
        });
        user.step = 3;
        break;
      }
      case 3: { // Hora
        const horaIndex = parseInt(text);
        if (isNaN(horaIndex) || horaIndex < 1 || horaIndex > user.horasDisponibles.length) {
          await sock.sendMessage(sender, { text: "❌ Hora inválida. Responde solo con el número de la lista." });
          return;
        }
        user.hora = user.horasDisponibles[horaIndex - 1];
        const fechaCompleta = formatDate(user.dia);

        // Guarda en Sheets
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "Citas!A2",
          valueInputOption: "RAW",
          requestBody: {
            values: [[user.dia, user.hora, user.nombre, sender, "activa", new Date().toISOString()]]
          }
        });

        // Guarda en Calendar
        await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: {
            summary: `Cita con ${user.nombre}`,
            description: "Agendada desde WhatsApp Bot " + sender,
            start: { dateTime: getNextDate(user.dia, user.hora), timeZone: TIMEZONE },
            end: { dateTime: getNextDate(user.dia, user.hora, 1), timeZone: TIMEZONE },
          }
        });

        await sock.sendMessage(sender, {
          text: `✅ Tu cita ha sido agendada para *${user.dia} ${fechaCompleta} a las ${user.hora}*. Gracias, ${user.nombre}.`
        });
        user.step = 0;
        break;
      }
      default:
        await sock.sendMessage(sender, { text: "Responde solo con el número de la opción." });
        user.step = 0;
        break;
    }
  });
};

startSock();
