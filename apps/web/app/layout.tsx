import type { Metadata } from "next";
import StoreProvider from "../src/store/StoreProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Web Crawler",
  description: "Web crawler dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}