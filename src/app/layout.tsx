import type { Metadata } from "next";
import { Literata } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "./globals.css";

const literata = Literata({
  variable: "--font-literata",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "wheredown.town",
  description: "Where downtown?",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="apple-mobile-web-app-title" content="downtown" />
        <meta name="theme-color" content="#1f1f1f" />
      </head>
      <GoogleAnalytics gaId="G-4MRZXXQ6K7" />
      <body className={literata.variable}>{children}</body>
    </html>
  );
}
