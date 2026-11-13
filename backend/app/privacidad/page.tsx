import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { diasDeRetencion } from "@/lib/retencion";

export const dynamic = "force-dynamic";

/**
 * Política de privacidad pública.
 *
 * Meta exige una URL de política de privacidad para pasar la app a modo
 * producción, y sin eso no entrega los mensajes reales de WhatsApp al webhook.
 * Queda fuera del middleware (su matcher cubre sólo /dashboard y /api/v1), así
 * que se ve sin sesión.
 *
 * Describe lo que el sistema hace de verdad: el plazo de conservación es el de
 * lib/retencion.ts y los pedidos de acceso o supresión los atiende el hotel por
 * email. El bot de WhatsApp no procesa esos pedidos. El email sale de
 * PRIVACY_CONTACT_EMAIL o, si no está, del email cargado para el hotel.
 */

export const metadata: Metadata = {
  title: "Política de privacidad — Roomly",
  description: "Cómo Roomly trata los datos de quienes reservan por WhatsApp.",
};

const ACTUALIZADA = "12 de noviembre de 2026";

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-zinc-900">{titulo}</h2>
      <div className="space-y-3 text-zinc-700 leading-relaxed">{children}</div>
    </section>
  );
}

export default async function PrivacidadPage() {
  const hotel = await prisma.hotel.findFirst({ select: { name: true, email: true } });
  const contacto = process.env.PRIVACY_CONTACT_EMAIL?.trim() || hotel?.email || null;
  const dias = diasDeRetencion();

  return (
    <main className="flex-1 bg-zinc-50">
      <article className="mx-auto max-w-2xl px-4 py-12 space-y-8">
        <header className="space-y-2">
          <p className="text-sm font-medium text-zinc-500">Roomly</p>
          <h1 className="text-3xl font-bold text-zinc-900">Política de privacidad</h1>
          <p className="text-sm text-zinc-500">Última actualización: {ACTUALIZADA}</p>
        </header>

        <p className="text-zinc-700 leading-relaxed">
          Roomly es un sistema de reservas de hotel que atiende por WhatsApp: un
          asistente responde consultas, muestra disponibilidad, crea la reserva y
          envía el link de pago. Esta política explica qué datos se tratan al
          usarlo, para qué y con quién se comparten. El responsable de los datos
          es {hotel?.name ?? "el hotel"}.
        </p>

        <Seccion titulo="Qué datos tratamos">
          <ul className="list-disc pl-5 space-y-1">
            <li>Tu número de teléfono de WhatsApp y el contenido de los mensajes que nos enviás.</li>
            <li>Los datos de la reserva: nombre del titular, fechas, cantidad de huéspedes y habitación.</li>
            <li>Tu email, sólo si elegís darlo para recibir la confirmación.</li>
            <li>
              El estado y el monto del pago. Los datos de tu tarjeta o cuenta los
              procesa Mercado Pago: Roomly no los recibe ni los guarda.
            </li>
          </ul>
        </Seccion>

        <Seccion titulo="Para qué los usamos">
          <ul className="list-disc pl-5 space-y-1">
            <li>Responder tus consultas y recordar el contexto de la conversación.</li>
            <li>Crear, consultar, modificar o cancelar tus reservas.</li>
            <li>Generar el link de pago, confirmar la reserva al acreditarse y avisarte por WhatsApp o email.</li>
            <li>
              Diagnosticar fallas del asistente. En esos registros técnicos el
              teléfono se guarda seudonimizado; las conversaciones, en cambio,
              guardan el número real, porque hace falta para responderte.
            </li>
          </ul>
          <p>No usamos tus datos para publicidad ni los vendemos a terceros.</p>
        </Seccion>

        <Seccion titulo="Con quién se comparten">
          <p>
            Para funcionar, Roomly usa proveedores que procesan los datos por cuenta
            nuestra y sólo para prestar el servicio:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Meta (WhatsApp Business):</strong> envío y recepción de mensajes.</li>
            <li><strong>Google (Gemini):</strong> genera las respuestas del asistente a partir de tus mensajes.</li>
            <li><strong>Google Calendar:</strong> agenda interna de las reservas del hotel.</li>
            <li><strong>Mercado Pago:</strong> cobro de la seña o del total.</li>
            <li><strong>Resend:</strong> envío del email de confirmación.</li>
            <li><strong>Vercel y Neon:</strong> alojamiento de la aplicación y de la base de datos.</li>
          </ul>
          <p>
            Algunos de estos proveedores procesan datos fuera de Argentina. Sólo se
            comparte lo necesario para cada función.
          </p>
        </Seccion>

        <Seccion titulo="Cuánto tiempo los guardamos">
          <p>
            Las conversaciones de WhatsApp y los registros técnicos del asistente
            se conservan {dias} días y después se borran automáticamente. Los datos
            de las reservas (titular, fechas, habitación y estado del pago) se
            conservan mientras el hotel los necesite para gestionar la estadía y
            cumplir obligaciones legales.
          </p>
        </Seccion>

        <Seccion titulo="Tus derechos">
          <p>
            Podés pedir acceso a tus datos, su rectificación o su eliminación, en los
            términos de la Ley 25.326 de Protección de Datos Personales.
          </p>
          <p>
            Para hacerlo, enviá un email
            {contacto ? (
              <>
                {" "}a{" "}
                <a href={`mailto:${contacto}`} className="text-zinc-900 underline">
                  {contacto}
                </a>
              </>
            ) : (
              <> al hotel</>
            )}{" "}
            indicando el número de WhatsApp con el que reservaste. El pedido lo
            atiende el personal del hotel; el asistente de WhatsApp no procesa estos
            pedidos. Si tenés una reserva con pago pendiente o en curso, algunos
            datos pueden conservarse hasta cerrarla.
          </p>
          <p className="text-sm text-zinc-500">
            La Agencia de Acceso a la Información Pública, en su carácter de Órgano
            de Control de la Ley 25.326, tiene la atribución de atender las
            denuncias y reclamos que interpongan quienes resulten afectados en sus
            derechos por incumplimiento de las normas vigentes en materia de
            protección de datos personales.
          </p>
        </Seccion>

        <Seccion titulo="Menores de edad">
          <p>Roomly no está dirigido a menores de 18 años. Las reservas debe hacerlas una persona adulta.</p>
        </Seccion>

        <Seccion titulo="Cambios en esta política">
          <p>
            Si cambia la forma en que tratamos los datos, actualizamos esta página y
            la fecha de arriba.
          </p>
        </Seccion>
      </article>
    </main>
  );
}
