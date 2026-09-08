import type { Metadata } from "next";
import { Sora, Karla, JetBrains_Mono } from "next/font/google";

import { ToastProvider } from "@/components/toast";

import "./globals.css";

// "Night Studio" identity — a friendly geometric display face for the OS
// chrome (menu bar, dock, headings), a warm humanist body face, and a
// monospace for URLs/session IDs/timestamps throughout the app.
const sora = Sora({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const karla = Karla({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "SpaceWorker",
    template: "%s · SpaceWorker",
  },
  description:
    "SpaceWorker — automation tools for lead extraction, filtering, and outreach.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sora.variable} ${karla.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* Dark-by-default with a per-browser toggle. Read localStorage before
            first paint to avoid a flash-of-wrong-theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("spaceworker-theme");var d=t==="dark"||(!t&&true);document.documentElement.classList.toggle("dark",d);}catch(e){document.documentElement.classList.add("dark");}})();`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}