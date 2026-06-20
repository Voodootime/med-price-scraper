import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MedPrice Tracker — скрапер медицинских прайсов",
  description:
    "Универсальный движок сбора цен и услуг с медицинских сайтов. Один регион, автоопределение тира, самовосстановление при изменении вёрстки.",
  keywords: [
    "MedPrice Tracker",
    "медицинские цены",
    "скрапинг",
    "конкуренты",
    "прайс-листы",
  ],
  authors: [{ name: "MedPrice Team" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "MedPrice Tracker",
    description: "Универсальный скрапер медицинских прайсов",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
