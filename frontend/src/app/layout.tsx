import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Laburen AI Agent",
  description: "Agente de producto con autenticación conversacional, RAG y herramientas reales",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
