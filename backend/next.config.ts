import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `output: "standalone"` se quitó junto con el Dockerfile del backend: sólo
  // hacía falta para el build multi-stage en contenedor. Vercel no lo usa.
  // El Dockerfile está archivado en docs/legacy/ por si hiciera falta volver.
  //
  // Fija la raíz del workspace a este directorio (backend). Sin esto, al haber
  // un package-lock.json también en la carpeta padre, Turbopack infiere la raíz
  // en el padre y escanea/cachea un árbol enorme → OOM al deserializar la caché.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
