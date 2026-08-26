import { redirect } from "next/navigation";

/**
 * La raíz no tiene contenido propio: esto es un panel de gestión, no un sitio
 * público. Se manda al dashboard, que a su vez rebota al login si no hay sesión.
 *
 * Antes acá vivía la página de bienvenida que trae Next.js al crear el
 * proyecto, que nunca se reemplazó y quedó publicada en producción.
 */
export default function Home() {
  redirect("/dashboard");
}
