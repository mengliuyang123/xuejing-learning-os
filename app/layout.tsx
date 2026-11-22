import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "学径 · 个人学习工作台",
  description: "在知识地图与时间轴之间，专注当下这一步。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
