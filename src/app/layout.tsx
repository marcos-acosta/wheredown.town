import type { Metadata } from "next";
import { Literata } from "next/font/google";
import "./globals.css";

const literata = Literata({
  variable: "--font-literata",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "wheredown.town",
  description: "Where downtown?",
  themeColor: "#1f1f1f",
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
      </head>
      <body className={literata.variable}>
        {children}
      </body>
    </html>
  );
}
