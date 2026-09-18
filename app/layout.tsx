import type { Metadata } from "next";
import { Sora, Karla, JetBrains_Mono } from "next/font/google";

import { ToastProvider } from "@/components/toast";
import { ConfirmProvider } from "@/components/confirm-provider";

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
            first paint to avoid a flash-of-wrong-theme.
            `?theme=dark|light` overrides localStorage entirely and is never
            persisted -- Vantra's Ops Console embeds this app in an iframe with
            that param set so the panel's theme is deterministic regardless of
            whatever this iframe's own (possibly stale/partitioned/reloaded-by-
            the-browser) localStorage happens to hold. Without this, a
            backgrounded-tab iframe reload could silently flip the embedded
            panel to a different theme than the rest of the console. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var q=new URLSearchParams(location.search).get("theme");var t=q==="dark"||q==="light"?q:localStorage.getItem("spaceworker-theme");var d=t==="dark"||(!t&&true);document.documentElement.classList.toggle("dark",d);}catch(e){document.documentElement.classList.add("dark");}})();`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <ToastProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </ToastProvider>
      </body>
    </html>
  );
}