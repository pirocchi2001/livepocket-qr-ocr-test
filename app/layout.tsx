import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LivePocket QR+OCR テスト',
  description: 'QRコード読み取り + OCR項目抽出の検証用アプリ',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
