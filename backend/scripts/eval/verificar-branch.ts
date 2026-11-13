/** Comprueba, sin escribir nada, que la base de la evaluación tiene el inventario del hotel. */
import "dotenv/config";
import { prisma } from "../../lib/prisma";

(async () => {
  const [hoteles, habitaciones, tarifas, reservas] = await Promise.all([
    prisma.hotel.count(),
    prisma.room.count(),
    prisma.ratePlan.count(),
    prisma.reservation.count(),
  ]);
  console.log({ hoteles, habitaciones, tarifas, reservas });
  await prisma.$disconnect();
  process.exit(hoteles > 0 && habitaciones > 0 && tarifas > 0 ? 0 : 1);
})();
