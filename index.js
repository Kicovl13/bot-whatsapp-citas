import dotenv from "dotenv";
dotenv.config();

import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as fs from "fs";

const sessions = {}; // Memoria temporal para seguimiento de usuarios

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""
    ).trim().toLowerCase();

    if (!sessions[sender]) sessions[sender] = { step: 0 };

    const user = sessions[sender];

    switch (user.step) {
      case 0:
        if (text.includes("cita")) {
          await sock.sendMessage(sender, {
            text: `¡Hola! Soy ${process.env.BOT_NAME || "el asistente de citas"}.\n\n¿Podrías decirme tu nombre completo para agendar la cita?`,
          });
          user.step = 1;
        } else {
          await sock.sendMessage(sender, {
            text:
              process.env.RESPUESTA_DEFAULT ||
              "Hola, soy el asistente automático. Escribe 'cita' para comenzar.",
          });
        }
        break;

      case 1:
        user.nombre = text;
        await sock.sendMessage(sender, {
          text: `Gracias, ${user.nombre}. ¿Qué día y hora te gustaría agendar tu cita?`,
        });
        user.step = 2;
        break;

      case 2:
        user.fecha = text;
        await sock.sendMessage(sender, {
          text: `Perfecto, ${user.nombre}. Tu cita ha sido registrada para *${user.fecha}*.\n\nPronto uno de nuestros asesores se pondrá en contacto contigo.\n\n¡Gracias por confiar en nosotros!`,
        });
        user.step = 3;

        // Aquí podrías guardar los datos en un archivo o base de datos:
        console.log("Nueva cita agendada:", {
          telefono: sender,
          nombre: user.nombre,
          fecha: user.fecha,
        });

        break;

      default:
        await sock.sendMessage(sender, {
          text: "¿Quieres agendar otra cita? Escribe 'cita' para comenzar.",
        });
        user.step = 0;
        break;
    }
  });
};

startSock();
