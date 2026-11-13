/**
 * Datos de la prueba de usabilidad del panel (docs/evaluacion/USABILIDAD.md).
 *
 *   npx tsx scripts/eval/usabilidad-datos.ts --crear     antes de cada sesión
 *   npx tsx scripts/eval/usabilidad-datos.ts --limpiar   después de cada sesión
 *
 * --crear arma, con fechas relativas al día de hoy en la zona del hotel:
 *   · Carla Méndez: confirmada, ingresa en 20 días, con conversación de WhatsApp (tareas 1 y 4)
 *   · Jorge Paz: confirmada, ingresa hoy (tarea 2)
 *   · Sofía Ríos: confirmada, ingresaba ayer (tarea 3)
 * y guarda el precio actual de cada tarifa, porque la tarea 5 cambia uno.
 *
 * --limpiar borra todo lo creado (reservas, huéspedes, mensajes, registros de
 * auditoría y tareas de limpieza de esos teléfonos) y restituye los precios.
 *
 * Escribe en la base de DATABASE_URL: correrlo sólo con el acuerdo de los autores.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma";
import { resolveHotelId } from "../../lib/agent/config";
import { hoyEnZona } from "../../services/reservation.service";
import { isRoomAvailable } from "../../services/availability.service";

const ESTADO = path.join(__dirname, ".usabilidad-estado.json");
const TELEFONOS = ["5490000000801", "5490000000802", "5490000000803"];
const MARCA = "PRUEBA DE USABILIDAD";

const masDias = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function habitacionLibre(hotelId: string, checkIn: string, checkOut: string, usadas: Set<string>) {
  const rooms = await prisma.room.findMany({ where: { hotelId }, orderBy: { number: "asc" }, select: { id: true, number: true } });
  for (const r of rooms) {
    if (usadas.has(r.id)) continue;
    if (await isRoomAvailable(r.id, checkIn, checkOut)) { usadas.add(r.id); return r; }
  }
  throw new Error(`No hay habitación libre del ${checkIn} al ${checkOut}.`);
}

async function crear() {
  if (fs.existsSync(ESTADO)) throw new Error("Ya hay datos de una sesión anterior: corré --limpiar primero.");
  const hotelId = await resolveHotelId();
  if (!hotelId) throw new Error("No hay hotel.");
  const hotel = await prisma.hotel.findUniqueOrThrow({ where: { id: hotelId }, select: { timezone: true } });
  const hoy = hoyEnZona(hotel.timezone);

  const planes = await prisma.ratePlan.findMany({ where: { hotelId }, select: { id: true, pricePerNight: true } });
  fs.writeFileSync(ESTADO, JSON.stringify({ hoy, precios: planes.map((p) => ({ id: p.id, precio: String(p.pricePerNight) })) }, null, 1));

  const usadas = new Set<string>();
  const casos = [
    { nombre: "Carla Méndez", tel: TELEFONOS[0], checkIn: masDias(hoy, 20), checkOut: masDias(hoy, 23), personas: 2, code: "RML-9801" },
    { nombre: "Jorge Paz", tel: TELEFONOS[1], checkIn: hoy, checkOut: masDias(hoy, 2), personas: 1, code: "RML-9802" },
    { nombre: "Sofía Ríos", tel: TELEFONOS[2], checkIn: masDias(hoy, -1), checkOut: masDias(hoy, 1), personas: 2, code: "RML-9803" },
  ];
  for (const c of casos) {
    const room = await habitacionLibre(hotelId, c.checkIn, c.checkOut, usadas);
    const guest = await prisma.guest.upsert({
      where: { hotelId_phone: { hotelId, phone: c.tel } },
      update: {},
      create: { hotelId, name: c.nombre, phone: c.tel },
    });
    const creadaEn = new Date(Date.now() - 2 * 86400000);
    await prisma.reservation.create({
      data: {
        hotelId, roomId: room.id, guestId: guest.id, guestName: c.nombre, code: c.code,
        status: "CONFIRMED", channel: "WHATSAPP", checkIn: new Date(c.checkIn), checkOut: new Date(c.checkOut),
        numGuests: c.personas, notes: MARCA, createdAt: creadaEn,
      },
    });
    console.log(`${c.code} ${c.nombre} · hab. ${room.number} · ${c.checkIn} → ${c.checkOut}`);
  }

  // Conversación de Carla Méndez (tarea 4): termina con el mensaje que nombra su código.
  const base = Date.now() - 2 * 86400000 - 10 * 60000;
  const chat: [string, "INBOUND" | "OUTBOUND"][] = [
    ["hola! tienen lugar para 2 dentro de tres semanas, de viernes a lunes?", "INBOUND"],
    ["¡Hola! Sí, tengo disponibilidad. ¿Me pasás el nombre del huésped?", "OUTBOUND"],
    ["Carla Méndez, pago el total", "INBOUND"],
    ["¡Listo, Carla! Tu reserva *RML-9801* quedó confirmada. ¡Te esperamos! 🏨", "OUTBOUND"],
  ];
  const guest = await prisma.guest.findUniqueOrThrow({ where: { hotelId_phone: { hotelId, phone: TELEFONOS[0] } } });
  for (const [i, [content, direction]] of chat.entries()) {
    await prisma.message.create({
      data: { hotelId, phone: TELEFONOS[0], guestId: guest.id, direction, content, createdAt: new Date(base + i * 60000) },
    });
  }
  console.log("Datos de la sesión creados. Al terminar: --limpiar");
}

async function limpiar() {
  const estado = fs.existsSync(ESTADO) ? JSON.parse(fs.readFileSync(ESTADO, "utf8")) : null;
  const reservas = await prisma.reservation.findMany({ where: { guest: { phone: { in: TELEFONOS } } }, select: { id: true } });
  const ids = reservas.map((r) => r.id);
  await prisma.$transaction([
    prisma.auditLog.deleteMany({ where: { reservationId: { in: ids } } }),
    prisma.housekeepingTask.deleteMany({ where: { reservationId: { in: ids } } }),
    prisma.payment.deleteMany({ where: { reservationId: { in: ids } } }),
    prisma.reservation.deleteMany({ where: { id: { in: ids } } }),
    prisma.message.deleteMany({ where: { phone: { in: TELEFONOS } } }),
    prisma.guest.deleteMany({ where: { phone: { in: TELEFONOS } } }),
  ]);
  if (estado) {
    for (const p of estado.precios as { id: string; precio: string }[]) {
      await prisma.ratePlan.update({ where: { id: p.id }, data: { pricePerNight: p.precio } });
    }
    fs.unlinkSync(ESTADO);
  }
  console.log(`Borradas ${ids.length} reservas de prueba${estado ? " y restituidos los precios" : ""}.`);
}

const accion = process.argv.includes("--crear") ? crear : process.argv.includes("--limpiar") ? limpiar : null;
if (!accion) { console.error("Uso: --crear | --limpiar"); process.exit(1); }
accion()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); })
  .finally(() => prisma.$disconnect());
