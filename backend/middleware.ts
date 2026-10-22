import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isOnDashboard = req.nextUrl.pathname.startsWith("/dashboard");
  const isApiProtected = req.nextUrl.pathname.startsWith("/api/v1");

  // Dashboard: redirect unauthenticated users to login
  if (isOnDashboard && !isLoggedIn) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // Webhook de Mercado Pago: público (MP no envía credenciales)
  const isMPWebhook = req.nextUrl.pathname === "/api/v1/payments/webhook";
  if (isMPWebhook) return NextResponse.next();

  // API routes: require either session or the X-N8N-Secret header.
  // El secreto ya no se acepta en la query string (`_s`): quedaba registrado en
  // logs de acceso, de proxies y en el Referer. Solo lo usaba el flujo de n8n,
  // que ya no está en uso (ver docs/legacy/).
  if (isApiProtected && !isLoggedIn) {
    const secret = req.headers.get("x-n8n-secret");
    if (!secret || secret !== process.env.N8N_WEBHOOK_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/dashboard/:path*", "/api/v1/:path*"],
};
