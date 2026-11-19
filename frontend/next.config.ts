import type { NextConfig } from "next";

const config: NextConfig = {
  outputFileTracingIncludes: {
    "/api/chat": [
      "public/historial_anual.json",
      "public/historial_departamento.json",
      "public/predicciones_anual.json",
      "public/predicciones_departamento.json",
      "public/scoring_distrito.json",
      "public/metadata.json",
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