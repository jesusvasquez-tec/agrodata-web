import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.NODE_ENV === "development" ? ".next" : ".next-production",
  outputFileTracingIncludes: {
    "/api/chat": [
      "./historial_anual.json",
      "./historial_departamento.json",
      "./predicciones_anual.json",
      "./predicciones_departamento.json",
      "./scoring_distrito.json",
      "./metadata.json",
    ],
  },
  async rewrites() {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000";
    return [
      {
        source: "/backend/:path*",
        destination: `${backendUrl}/:path*`,
      },
    ];
  },
};

export default config;