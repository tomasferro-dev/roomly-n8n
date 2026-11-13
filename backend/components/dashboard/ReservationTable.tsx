"use client";

import { Fragment, useState, useTransition } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import EditableGuestCell from "@/components/dashboard/EditableGuestCell";
import ChatDrawer from "@/components/dashboard/ChatDrawer";
import { checkoutReservation, cambiarEstadoReserva } from "@/app/dashboard/actions";

type Reservation = {
  id: string;
  code: string;
  status: string;
  channel: string;
  checkIn: Date;
  checkOut: Date;
  numGuests: number;
  guestName: string | null;
  createdAt: Date;
  room: { number: string };
  guest: {
    id: string;
    name: string;
    phone: string;
    email?: string | null;
    dni?: string | null;
  };
  ratePlan?: { name: string; pricePerNight: number } | null;
};

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  CONFIRMED: { label: "Confirmada", variant: "default" },
  CHECKED_IN: { label: "Hospedado", variant: "secondary" },
  CHECKED_OUT: { label: "Salida", variant: "outline" },
  CANCELLED: { label: "Cancelada", variant: "destructive" },
  PENDING: { label: "Pendiente", variant: "outline" },
  PENDING_PAYMENT: { label: "Esperando pago", variant: "outline" },
  NO_SHOW: { label: "No presentó", variant: "destructive" },
};

function formatDate(d: Date) {
  // Dates come from Prisma as midnight UTC (e.g. 2026-05-27T00:00:00.000Z).
  // Without timeZone: "UTC", the browser (UTC-3) would render "26/05/2026".
  return new Date(d).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDateTime(d: Date) {
  // createdAt is a real instant (not a @db.Date), so show it in local time.
  return new Date(d).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function nightsBetween(a: Date, b: Date) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function formatPrice(n: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(n);
}

/** Returns true if a reservation's checkout date has already passed and it's still open */
function isCheckoutOverdue(r: { checkOut: Date; status: string }): boolean {
  const now = new Date();
  const todayUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  return (
    ["CONFIRMED", "CHECKED_IN"].includes(r.status) &&
    new Date(r.checkOut) < todayUTC
  );
}

/** True si el día de ingreso todavía no llegó (fechas @db.Date, en UTC). */
function isBeforeCheckIn(checkIn: Date): boolean {
  const now = new Date();
  const hoy = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return hoy < new Date(checkIn).toISOString().slice(0, 10);
}

const COLSPAN = 6;

export default function ReservationTable({
  reservations,
}: {
  reservations: Reservation[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [chat, setChat] = useState<{ id: string; title: string } | null>(null);
  const [checkingOutId, setCheckingOutId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCheckout(id: string) {
    setCheckingOutId(id);
    startTransition(async () => {
      await checkoutReservation(id);
      setCheckingOutId(null);
    });
  }

  function handleEstado(id: string, accion: "CHECK_IN" | "NO_SHOW") {
    if (accion === "NO_SHOW" && !confirm("¿Marcar la reserva como no presentada? La habitación queda libre.")) return;
    setCheckingOutId(id);
    startTransition(async () => {
      const r = await cambiarEstadoReserva(id, accion);
      if (r.error) alert(r.error);
      setCheckingOutId(null);
    });
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (reservations.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-500 text-sm">
        No hay reservas registradas.
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="border-zinc-800 hover:bg-transparent">
            <TableHead className="text-zinc-400">Código</TableHead>
            <TableHead className="text-zinc-400">Huésped</TableHead>
            <TableHead className="text-zinc-400">Hab.</TableHead>
            <TableHead className="text-zinc-400">Check-in</TableHead>
            <TableHead className="text-zinc-400">Check-out</TableHead>
            <TableHead className="text-zinc-400">Estado</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reservations.map((r) => {
            const { label, variant } = statusConfig[r.status] ?? {
              label: r.status,
              variant: "outline" as const,
            };
            const isOpen = expanded.has(r.id);
            const overdue = isCheckoutOverdue(r);
            const nights = nightsBetween(r.checkIn, r.checkOut);
            const canCheckout = ["CONFIRMED", "CHECKED_IN"].includes(r.status);
            // Ingreso y no presentación, desde el día de ingreso (el servidor
            // lo vuelve a verificar con la zona horaria del hotel).
            const canArrive = r.status === "CONFIRMED" && !isBeforeCheckIn(r.checkIn);
            const isProcessing = checkingOutId === r.id && isPending;

            return (
              <Fragment key={r.id}>
                <TableRow
                  onClick={() => toggle(r.id)}
                  className="border-zinc-800 hover:bg-zinc-800/50 cursor-pointer"
                >
                  <TableCell className="font-mono text-blue-400">
                    <span className="inline-flex items-center gap-2">
                      <span className="text-zinc-500 text-xs w-3 inline-block">
                        {isOpen ? "▾" : "▸"}
                      </span>
                      {r.code}
                    </span>
                  </TableCell>
                  <TableCell
                    className="align-top py-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <EditableGuestCell
                      reservationId={r.id}
                      guestId={r.guest.id}
                      name={r.guestName ?? r.guest.name}
                      phone={r.guest.phone}
                      email={r.guest.email}
                      dni={r.guest.dni}
                    />
                  </TableCell>
                  <TableCell>{r.room.number}</TableCell>
                  <TableCell>{formatDate(r.checkIn)}</TableCell>
                  <TableCell>{formatDate(r.checkOut)}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <Badge variant={variant}>{label}</Badge>
                      {overdue && (
                        <Badge
                          variant="outline"
                          className="text-orange-400 border-orange-500 text-[10px] whitespace-nowrap"
                        >
                          Checkout vencido
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>

                {isOpen && (
                  <TableRow
                    className="border-zinc-800 bg-zinc-950/40 hover:bg-zinc-950/40"
                  >
                    <TableCell colSpan={COLSPAN} className="py-4">
                      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
                        <div>
                          <span className="text-zinc-500">Noches: </span>
                          {nights}
                        </div>
                        <div>
                          <span className="text-zinc-500">Personas: </span>
                          {r.numGuests}
                        </div>
                        <div>
                          <span className="text-zinc-500">Canal: </span>
                          <span className="uppercase text-xs">{r.channel}</span>
                        </div>
                        {r.ratePlan && (
                          <div>
                            <span className="text-zinc-500">Tarifa: </span>
                            {r.ratePlan.name} · {formatPrice(r.ratePlan.pricePerNight)}/noche
                          </div>
                        )}
                        {r.ratePlan && (
                          <div>
                            <span className="text-zinc-500">Total estimado: </span>
                            <span className="text-white font-medium">
                              {formatPrice(r.ratePlan.pricePerNight * nights)}
                            </span>
                          </div>
                        )}
                        <div>
                          <span className="text-zinc-500">Creada el: </span>
                          {formatDateTime(r.createdAt)}
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                          {canArrive && (
                            <>
                              <button
                                type="button"
                                disabled={isProcessing}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleEstado(r.id, "CHECK_IN");
                                }}
                                className="text-sm bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded px-3 py-1.5 transition-colors"
                              >
                                Registrar ingreso
                              </button>
                              <button
                                type="button"
                                disabled={isProcessing}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleEstado(r.id, "NO_SHOW");
                                }}
                                className="text-sm bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-200 rounded px-3 py-1.5 transition-colors"
                              >
                                No se presentó
                              </button>
                            </>
                          )}
                          {canCheckout && (
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCheckout(r.id);
                              }}
                              className="text-sm bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded px-3 py-1.5 transition-colors"
                            >
                              {isProcessing ? "Cerrando..." : "Cerrar reserva"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setChat({
                                id: r.id,
                                title: `${r.code} · ${r.guestName ?? r.guest.name}`,
                              });
                            }}
                            className="text-sm bg-blue-600 hover:bg-blue-500 text-white rounded px-3 py-1.5 transition-colors"
                          >
                            Ver chat
                          </button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      <ChatDrawer
        reservationId={chat?.id ?? null}
        title={chat?.title}
        onClose={() => setChat(null)}
      />
    </>
  );
}
