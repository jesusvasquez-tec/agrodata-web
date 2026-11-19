import type { NextConfig } from "next";

const config: NextConfig = {
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
    return [
      {
        source: "/backend/:path*",
        destination: "https://agrodata-api-633c.onrender.com/:path*",
      },
    ];
  },
};

export default config;